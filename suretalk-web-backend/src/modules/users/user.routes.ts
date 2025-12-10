import { Router } from 'express';
import { UserController } from './user.controller';
import { authenticate } from '../../middleware/auth.middleware';

const router = Router();
const userController = new UserController();

// All routes require authentication
router.use(authenticate);

// User profile routes
router.get('/profile', userController.getProfile.bind(userController));
router.put('/profile', userController.updateProfile.bind(userController));
router.post('/change-password', userController.changePassword.bind(userController));

// Dashboard stats
router.get('/dashboard/stats', userController.getDashboardStats.bind(userController));

export default router;