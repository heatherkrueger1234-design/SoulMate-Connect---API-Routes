const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { body, validationResult } = require('express-validator');
const router = express.Router();

// Register
router.post('/register', [
  body('firstName').trim().isLength({ min: 2 }).escape(),
  body('lastName').trim().isLength({ min: 2 }).escape(),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('dateOfBirth').isISO8601(),
  body('gender').isIn(['male', 'female', 'non-binary'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { firstName, lastName, email, password, dateOfBirth, gender, location, referredBy } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Age verification (must be 18+)
    const age = Math.floor((new Date() - new Date(dateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000));
    if (age < 18) {
      return res.status(400).json({ message: 'Must be 18 or older to register' });
    }

    // First 1000 users get premium
    const userCount = await User.countDocuments();
    const subscription = {
      plan: userCount < 1000 ? 'premium' : 'free',
      status: 'active',
      startDate: new Date(),
      endDate: userCount < 1000 ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) : null
    };

    const user = new User({
      firstName,
      lastName,
      email,
      password,
      dateOfBirth,
      gender,
      location,
      subscription,
      referredBy
    });

    await user.save();

    // Update referrer count
    if (referredBy) {
      await User.findByIdAndUpdate(referredBy, { $inc: { referralCount: 1 } });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        subscription: user.subscription,
        isFirstThousand: userCount < 1000
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').exists()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    if (user.isBanned) {
      return res.status(403).json({ message: 'Account suspended for safety violations' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Update last active
    user.lastActive = new Date();
    await user.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        subscription: user.subscription,
        isEmailVerified: user.isEmailVerified,
        isPhoneVerified: user.isPhoneVerified,
        profileComplete: !!(user.photos.length && user.personalityTraits)
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
