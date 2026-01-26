// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\contacts.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, validateTier } = require('../middleware/auth');
const { pool } = require('../config/database');





// Get contact statistics
router.get('/stats', authenticate, async (req, res) => {
  try {
    const statsQuery = await pool.query(
      `SELECT 
        COUNT(*) as total_contacts,
        COUNT(CASE WHEN is_beneficiary THEN 1 END) as beneficiaries,
        COUNT(CASE WHEN can_receive_messages THEN 1 END) as can_receive_messages
       FROM contacts 
       WHERE user_id = $1`,
      [req.user.id]
    );

    // Get user's contact limit
    const userQuery = await pool.query(
      'SELECT contacts_limit, subscription_tier FROM users WHERE id = $1',
      [req.user.id]
    );

    const user = userQuery.rows[0];

    res.json({
      success: true,
      data: {
        ...statsQuery.rows[0],
        contact_limit: user.contacts_limit,
        remaining_contacts: user.contacts_limit - statsQuery.rows[0].total_contacts,
        tier: user.subscription_tier
      }
    });

  } catch (error) {
    console.error('Get contact stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contact statistics'
    });
  }
});

// Get all contacts for user
router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT c.*, 
             (SELECT COUNT(*) FROM contacts WHERE user_id = $1) as total_count
      FROM contacts c
      WHERE c.user_id = $1
    `;

    const queryParams = [req.user.id];
    let paramCount = 2;

    // Apply search
    if (search) {
      query += ` AND (c.name ILIKE $${paramCount} OR c.phone ILIKE $${paramCount} OR c.email ILIKE $${paramCount})`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    // Order and pagination
    query += ` ORDER BY c.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await pool.query(query, queryParams);

    res.json({
      success: true,
      data: {
        contacts: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: result.rows[0]?.total_count || 0,
          totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
        }
      }
    });

  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contacts'
    });
  }
});

// Get single contact
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM contacts WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Get contact error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contact'
    });
  }
});

// Create new contact - Updated version
router.post('/', authenticate, [
  body('name').notEmpty().trim().withMessage('Name is required'),
  body('phone').isMobilePhone().withMessage('Valid phone number is required'),
  body('email').optional().isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('relationship').optional().trim(),
  body('isBeneficiary').optional().isBoolean().withMessage('isBeneficiary must be boolean'),
  body('canReceiveMessages').optional().isBoolean().withMessage('canReceiveMessages must be boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { name, phone, email, relationship, isBeneficiary, canReceiveMessages, notes } = req.body;

    // Log the received data for debugging
    console.log('Received contact data:', req.body);

    // Check user's contact limit
    const userQuery = await pool.query(
      `SELECT subscription_tier, contacts_limit,
              (SELECT COUNT(*) FROM contacts WHERE user_id = $1) as contact_count
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    const user = userQuery.rows[0];
    const tier = user.subscription_tier;

    // Apply limits
    if (tier === 'LITE' && user.contact_count >= 3) {
      return res.status(403).json({
        success: false,
        error: 'LITE tier limit reached (3 contacts max). Upgrade to add more contacts.'
      });
    }

    if (user.contact_count >= user.contacts_limit) {
      return res.status(403).json({
        success: false,
        error: `Contact limit reached (${user.contacts_limit} contacts max). Upgrade to add more contacts.`
      });
    }

    // Check for duplicate phone number
    const duplicateCheck = await pool.query(
      'SELECT id FROM contacts WHERE user_id = $1 AND phone = $2',
      [req.user.id, phone]
    );

    if (duplicateCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Contact with this phone number already exists'
      });
    }

    // Create contact
    const result = await pool.query(
      `INSERT INTO contacts (
        user_id, name, phone, email, relationship, 
        is_beneficiary, can_receive_messages, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        req.user.id,
        name,
        phone,
        email || null,
        relationship || null,
        isBeneficiary || false,
        canReceiveMessages !== undefined ? canReceiveMessages : true, // Default to true
        notes || null
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Contact created successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Create contact error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create contact'
    });
  }
});

// Update contact
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, relationship, isBeneficiary, notes, canReceiveMessages } = req.body;

    // Check ownership
    const ownershipCheck = await pool.query(
      'SELECT id FROM contacts WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    // If phone is being updated, check for duplicates
    if (phone) {
      const duplicateCheck = await pool.query(
        'SELECT id FROM contacts WHERE user_id = $1 AND phone = $2 AND id != $3',
        [req.user.id, phone, id]
      );

      if (duplicateCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Another contact with this phone number already exists'
        });
      }
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount}`);
      values.push(name);
      paramCount++;
    }

    if (phone !== undefined) {
      updates.push(`phone = $${paramCount}`);
      values.push(phone);
      paramCount++;
    }

    if (email !== undefined) {
      updates.push(`email = $${paramCount}`);
      values.push(email);
      paramCount++;
    }

    if (relationship !== undefined) {
      updates.push(`relationship = $${paramCount}`);
      values.push(relationship);
      paramCount++;
    }

    if (isBeneficiary !== undefined) {
      updates.push(`is_beneficiary = $${paramCount}`);
      values.push(isBeneficiary);
      paramCount++;
    }

    if (notes !== undefined) {
      updates.push(`notes = $${paramCount}`);
      values.push(notes);
      paramCount++;
    }

    if (canReceiveMessages !== undefined) {
      updates.push(`can_receive_messages = $${paramCount}`);
      values.push(canReceiveMessages);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No updates provided'
      });
    }

    values.push(id);
    values.push(req.user.id);

    const query = `
      UPDATE contacts 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount} AND user_id = $${paramCount + 1}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    res.json({
      success: true,
      message: 'Contact updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update contact error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update contact'
    });
  }
});

// Delete contact
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Check ownership
    const ownershipCheck = await pool.query(
      'SELECT id FROM contacts WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    // Delete contact
    await pool.query(
      'DELETE FROM contacts WHERE id = $1',
      [id]
    );

    res.json({
      success: true,
      message: 'Contact deleted successfully'
    });

  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete contact'
    });
  }
});



// Get beneficiaries (for voice wills)
router.get('/beneficiaries', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, email, relationship
       FROM contacts 
       WHERE user_id = $1 AND is_beneficiary = true
       ORDER BY name`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get beneficiaries error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch beneficiaries'
    });
  }
});

module.exports = router;