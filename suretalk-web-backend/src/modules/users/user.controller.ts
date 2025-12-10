import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../index';
import { logger } from '../../index';
import { AuthRequest } from '../../middleware/auth.middleware';

// Validation schemas
const updateProfileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional()
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(6),
  newPassword: z.string().min(8)
});

export class UserController {
  async getProfile(req: AuthRequest, res: Response) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: {
          id: true,
          email: true,
          phone: true,
          firstName: true,
          lastName: true,
          subscriptionTier: true,
          verified: true,
          emailVerified: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          createdAt: true,
          updatedAt: true,
          lastLogin: true,
          status: true,
          _count: {
            select: {
              voiceNotes: true,
              contacts: true,
              voiceWills: true,
              scheduledMessages: true
            }
          }
        }
      });

      if (!user) {
        return res.status(404).json({
          error: 'User not found',
          message: 'User account not found'
        });
      }

      return res.json({
        success: true,
        user
      });
    } catch (error) {
      logger.error('Get profile error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to fetch profile'
      });
    }
  }

  async updateProfile(req: AuthRequest, res: Response) {
    try {
      const data = updateProfileSchema.parse(req.body);

      const user = await prisma.user.update({
        where: { id: req.user!.userId },
        data: {
          ...data,
          updatedAt: new Date()
        }
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'PROFILE_UPDATED',
          details: data
        }
      });

      return res.json({
        success: true,
        message: 'Profile updated successfully'
      });
    } catch (error) {
      logger.error('Update profile error:', error);
      
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: error.errors
        });
      }

      return res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to update profile'
      });
    }
  }

  async changePassword(req: AuthRequest, res: Response) {
    try {
      const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

      // Get user with current password
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId }
      });

      if (!user) {
        return res.status(404).json({
          error: 'User not found',
          message: 'User account not found'
        });
      }

      // Verify current password
      const validPassword = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!validPassword) {
        return res.status(401).json({
          error: 'Invalid password',
          message: 'Current password is incorrect'
        });
      }

      // Hash new password
      const newPasswordHash = await bcrypt.hash(newPassword, 12);

      // Update password
      await prisma.user.update({
        where: { id: req.user!.userId },
        data: {
          passwordHash: newPasswordHash,
          updatedAt: new Date()
        }
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'PASSWORD_CHANGED'
        }
      });

      // Invalidate all sessions except current
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        await prisma.session.deleteMany({
          where: {
            userId: user.id,
            NOT: { token }
          }
        });
      }

      return res.json({
        success: true,
        message: 'Password updated successfully'
      });
    } catch (error) {
      logger.error('Change password error:', error);
      
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: error.errors
        });
      }

      return res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to change password'
      });
    }
  }

  async getDashboardStats(req: AuthRequest, res: Response) {
    try {
      const userId = req.user!.userId;

      // Get counts
      const [
        voiceNotesCount,
        contactsCount,
        scheduledCount,
        storageUsed
      ] = await Promise.all([
        prisma.voiceNote.count({ where: { userId, deletedAt: null } }),
        prisma.contact.count({ where: { userId } }),
        prisma.scheduledMessage.count({ 
          where: { 
            userId, 
            status: 'PENDING',
            scheduledFor: { gt: new Date() }
          }
        }),
        prisma.voiceNote.aggregate({
          where: { userId, deletedAt: null },
          _sum: { fileSize: true }
        })
      ]);

      // Get recent voice notes
      const recentNotes = await prisma.voiceNote.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          title: true,
          duration: true,
          createdAt: true,
          storageClass: true,
          isPermanent: true
        }
      });

      return res.json({
        success: true,
        stats: {
          voiceNotes: voiceNotesCount,
          contacts: contactsCount,
          scheduled: scheduledCount,
          storageUsed: storageUsed._sum.fileSize || 0
        },
        recentNotes
      });
    } catch (error) {
      logger.error('Get dashboard stats error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to fetch dashboard statistics'
      });
    }
  }
}