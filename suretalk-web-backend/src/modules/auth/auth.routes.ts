import { Router } from 'express';
import { AuthController } from './auth.controller';

const router = Router();
const authController = new AuthController();

// Public routes
router.post('/login', authController.login.bind(authController));
router.post('/signup', authController.signup.bind(authController));
router.post('/logout', authController.logout.bind(authController));
router.get('/verify-email', authController.verifyEmail.bind(authController));

export default router;