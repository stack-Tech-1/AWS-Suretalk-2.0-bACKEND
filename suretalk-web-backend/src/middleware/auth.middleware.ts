import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../index';

export interface AuthRequest extends Request {
  user?: {
    userId: string;
    email: string;
    tier: string;
    isAdmin: boolean;
  };
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'No authentication token provided'
      });
    }

    // Verify JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    // Check if session exists (optional)
    const session = await prisma.session.findFirst({
      where: {
        token,
        expiresAt: { gt: new Date() }
      }
    });

    if (!session) {
      return res.status(401).json({
        error: 'Session expired',
        message: 'Please login again'
      });
    }

    // Attach user to request
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      tier: decoded.tier,
      isAdmin: decoded.isAdmin || false
    };

    return next();
  } catch (error) {
    return res.status(401).json({
      error: 'Authentication failed',
      message: 'Invalid or expired token'
    });
  }
};

export const requireAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user?.isAdmin) {
    return res.status(403).json({
      error: 'Permission denied',
      message: 'Admin access required'
    });
  }
  return next();
};

export const requireTier = (requiredTier: string) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const tierHierarchy = ['LITE', 'ESSENTIAL', 'PREMIUM'];
    const userTierIndex = tierHierarchy.indexOf(req.user?.tier || 'LITE');
    const requiredTierIndex = tierHierarchy.indexOf(requiredTier);

    if (userTierIndex < requiredTierIndex) {
      return res.status(403).json({
        error: 'Upgrade required',
        message: `This feature requires ${requiredTier} tier or higher`,
        currentTier: req.user?.tier,
        requiredTier
      });
    }

    return next();
  };
};