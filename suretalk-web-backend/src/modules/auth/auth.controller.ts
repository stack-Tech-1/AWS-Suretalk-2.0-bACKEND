import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../../index';
import { logger } from '../../index';

// Validation schemas
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  subscriptionTier: z.enum(['LITE', 'ESSENTIAL', 'PREMIUM']).default('LITE')
});

export class AuthController {
  async login(req: Request, res: Response) {
    try {
      const { email, password } = loginSchema.parse(req.body);

      // Find user
      const user = await prisma.user.findUnique({
        where: { email },
        include: {
          voiceNotes: {
            take: 5,
            orderBy: { createdAt: 'desc' }
          },
          contacts: {
            take: 5
          }
        }
      });

      if (!user) {
        return res.status(401).json({
          error: 'Authentication failed',
          message: 'Invalid email or password'
        });
      }

      // Check password
      const validPassword = await bcrypt.compare(password, user.passwordHash);
      if (!validPassword) {
        return res.status(401).json({
          error: 'Authentication failed',
          message: 'Invalid email or password'
        });
      }

      // Check if user is verified
      if (!user.emailVerified) {
        return res.status(403).json({
          error: 'Email not verified',
          message: 'Please verify your email before logging in'
        });
      }

      // Update last login
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() }
      });

      // Create JWT token
      const token = jwt.sign(
        {
          userId: user.id,
          email: user.email,
          tier: user.subscriptionTier,
          isAdmin: user.isAdmin
        },
        process.env.JWT_SECRET!,
        { expiresIn: process.env.JWT_EXPIRY || '7d' }
      );

      // Create session (optional)
      await prisma.session.create({
        data: {
          userId: user.id,
          token,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
          userAgent: req.headers['user-agent'] || '',
          ipAddress: req.ip
        }
      });

      // Log login
      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'USER_LOGIN',
          ipAddress: req.ip || '',
          userAgent: req.headers['user-agent'] || ''
        }
      });

      // Return user data (excluding sensitive info)
      const { passwordHash, ...userWithoutPassword } = user;

      return res.json({
        success: true,
        token,
        user: userWithoutPassword
      });

    } catch (error) {
      logger.error('Login error:', error);
      
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: error.errors
        });
      }

      return res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to process login request'
      });
    }
  }

  async signup(req: Request, res: Response) {
    try {
      const data = signupSchema.parse(req.body);

      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { email: data.email }
      });

      if (existingUser) {
        return res.status(409).json({
          error: 'User already exists',
          message: 'An account with this email already exists'
        });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(data.password, 12);

      // Create user
      const user = await prisma.user.create({
        data: {
          email: data.email,
          passwordHash,
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          subscriptionTier: data.subscriptionTier
        }
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'USER_CREATED',
          details: { tier: data.subscriptionTier }
        }
      });

      // TODO: Send verification email
      // await sendVerificationEmail(user.email, user.id);

      // Return success (don't send token yet - email verification required)
      return res.status(201).json({
        success: true,
        message: 'Account created successfully. Please check your email for verification.',
        userId: user.id
      });

    } catch (error) {
      logger.error('Signup error:', error);
      
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: error.errors
        });
      }

      return res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to create account'
      });
    }
  }

  async logout(req: Request, res: Response) {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      
      if (token) {
        await prisma.session.deleteMany({
          where: { token }
        });
      }

      return res.json({
        success: true,
        message: 'Logged out successfully'
      });
    } catch (error) {
      logger.error('Logout error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to logout'
      });
    }
  }

  async verifyEmail(req: Request, res: Response) {
    try {
      const { token } = req.query;

      if (!token || typeof token !== 'string') {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Verification token is required'
        });
      }

      // TODO: Implement actual token verification
      // For now, return a placeholder response
      return res.json({
        success: true,
        message: 'Email verification endpoint - implement token verification logic'
      });
    } catch (error) {
      logger.error('Email verification error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to verify email'
      });
    }
  }
}