const express = require('express');
const User = require('../models/User');
const Match = require('../models/Match');
const MatchingService = require('../services/MatchingService');
const auth = require('../middleware/auth');
const router = express.Router();

// Get potential matches
router.get('/discover', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const matches = await MatchingService.findPotentialMatches(user);
    
    res.json({
      matches,
      compatibilityOdds: user.aiInsights?.compatibilityOdds || "Calculating your perfect match odds...",
      dailyMatches: matches.length
    });
  } catch (error) {
    res.status(500).json({ message: 'Error finding matches', error: error.message });
  }
});

// Like/Pass on a user
router.post('/action', auth, async (req, res) => {
  try {
    const { targetUserId, action } = req.body; // action: 'like', 'pass', 'super_like'
    const userId = req.userId;

    if (userId === targetUserId) {
      return res.status(400).json({ message: 'Cannot action yourself' });
    }

    // Find or create match
    let match = await Match.findOne({
      $or: [
        { user1: userId, user2: targetUserId },
        { user1: targetUserId, user2: userId }
      ]
    });

    if (!match) {
      const compatibilityScore = await MatchingService.calculateCompatibility(userId, targetUserId);
      match = new Match({
        user1: userId,
        user2: targetUserId,
        compatibilityScore,
        matchType: compatibilityScore >= 90 ? 'perfect' : 
                  compatibilityScore >= 80 ? 'excellent' :
                  compatibilityScore >= 70 ? 'good' : 'potential'
      });
    }

    // Update user action
    if (match.user1.toString() === userId) {
      match.user1Action = action;
    } else {
      match.user2Action = action;
    }

    // Check for mutual match
    if (match.user1Action === 'like' && match.user2Action === 'like') {
      match.status = 'mutual';
    } else if (action === 'pass') {
      match.status = 'rejected';
    }

    await match.save();

    // If mutual match, trigger AI analysis
    if (match.status === 'mutual') {
      match.aiAnalysis = await MatchingService.generateMatchAnalysis(userId, targetUserId);
      await match.save();
    }

    res.json({
      match: match.status === 'mutual',
      matchId: match._id,
      message: match.status === 'mutual' ? "It's a match! 💕" : "Action recorded"
    });
  } catch (error) {
    res.status(500).json({ message: 'Error processing action', error: error.message });
  }
});

// Get user's matches
router.get('/matches', auth, async (req, res) => {
  try {
    const matches = await Match.find({
      $or: [{ user1: req.userId }, { user2: req.userId }],
      status: 'mutual'
    }).populate('user1 user2', 'firstName photos location personalityType');

    res.json(matches);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching matches', error: error.message });
  }
});

module.exports = router;



// backend/services/MatchingService.js
const OpenAI = require('openai');
const User = require('../models/User');
const Match = require('../models/Match');
const Revenue = require('../models/Revenue');

class MatchingService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }

    async calculateCompatibility(user1, user2) {
        // Deep personality compatibility - 1 in 10,000 claim
        const personalityScore = this.analyzePersonalityTraits(user1.personalityTraits, user2.personalityTraits);
        const lifestyleScore = this.analyzeLifestyle(user1, user2);
        const dealBreakerScore = this.checkDealBreakers(user1, user2);
        
        const compatibility = (personalityScore * 0.6 + lifestyleScore * 0.3 + dealBreakerScore * 0.1);
        
        // AI enhancement for premium users
        if (user1.subscriptionTier !== 'free') {
            const aiInsight = await this.getAICompatibilityInsight(user1, user2, compatibility);
            return { compatibility, aiInsight };
        }
        
        return { compatibility, aiInsight: null };
    }

    analyzePersonalityTraits(traits1, traits2) {
        const weights = {
            openness: 0.15,
            conscientiousness: 0.20,
            extraversion: 0.18,
            agreeableness: 0.22,
            neuroticism: 0.15,
            emotionalIntelligence: 0.10
        };
        
        let score = 0;
        for (const trait in weights) {
            const diff = Math.abs(traits1[trait] - traits2[trait]);
            score += (1 - diff / 100) * weights[trait];
        }
        
        return Math.max(0, score * 100);
    }

    checkDealBreakers(user1, user2) {
        const dealBreakers1 = user1.dealBreakers || {};
        const dealBreakers2 = user2.dealBreakers || {};
        
        // Check smoking
        if (dealBreakers1.smoking && user2.lifestyle?.smoking) return 0;
        if (dealBreakers2.smoking && user1.lifestyle?.smoking) return 0;
        
        // Check kids
        if (dealBreakers1.hasKids && user2.hasKids) return 0;
        if (dealBreakers2.hasKids && user1.hasKids) return 0;
        
        // Check pets
        if (dealBreakers1.pets && user2.hasPets) return 0;
        if (dealBreakers2.pets && user1.hasPets) return 0;
        
        return 100;
    }

    async getAICompatibilityInsight(user1, user2, score) {
        try {
            const prompt = `Analyze compatibility between two people:
Person 1: ${JSON.stringify(user1.personalityTraits)}
Person 2: ${JSON.stringify(user2.personalityTraits)}
Compatibility Score: ${score}%

Provide specific insights about why they match and potential challenges.`;

            const response = await this.openai.chat.completions.create({
                model: "gpt-4",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 300
            });

            return response.choices[0].message.content;
        } catch (error) {
            console.error('AI insight error:', error);
            return null;
        }
    }

    async findMatches(userId, limit = 10) {
        const user = await User.findById(userId);
        const potentialMatches = await User.find({
            _id: { $ne: userId },
            isActive: true,
            location: { $near: user.location, $maxDistance: user.preferences.maxDistance }
        });

        const matches = [];
        for (const potential of potentialMatches) {
            const compatibility = await this.calculateCompatibility(user, potential);
            
            if (compatibility.compatibility > 70) {
                matches.push({
                    user: potential,
                    compatibility: compatibility.compatibility,
                    aiInsight: compatibility.aiInsight
                });
            }
        }

        return matches.sort((a, b) => b.compatibility - a.compatibility).slice(0, limit);
    }
}

// backend/services/RevenueService.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Revenue = require('../models/Revenue');
const nodemailer = require('nodemailer');

class RevenueService {
    constructor() {
        this.emailTransporter = nodemailer.createTransporter({
            service: 'gmail',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
        
        this.targetDaily = 23333; // $233.33 daily target
    }

    async createSubscription(userId, priceId, paymentMethodId) {
        try {
            const customer = await stripe.customers.create({
                metadata: { userId }
            });

            await stripe.paymentMethods.attach(paymentMethodId, {
                customer: customer.id
            });

            const subscription = await stripe.subscriptions.create({
                customer: customer.id,
                items: [{ price: priceId }],
                default_payment_method: paymentMethodId,
                metadata: { userId }
            });

            // Track revenue immediately
            await this.trackRevenue(userId, this.getPriceAmount(priceId), 'subscription');
            
            return subscription;
        } catch (error) {
            console.error('Subscription creation failed:', error);
            throw error;
        }
    }

    async processIDVerification(userId, amount = 500) { // $5.00 in cents
        try {
            const paymentIntent = await stripe.paymentIntents.create({
                amount,
                currency: 'usd',
                metadata: { userId, type: 'id_verification' }
            });

            await this.trackRevenue(userId, amount, 'id_verification');
            
            return paymentIntent;
        } catch (error) {
            console.error('ID verification payment failed:', error);
            throw error;
        }
    }

    async trackRevenue(userId, amount, type) {
        const revenue = new Revenue({
            userId,
            amount: amount / 100, // Convert cents to dollars
            type,
            timestamp: new Date()
        });
        
        await revenue.save();
        
        // Send instant notification to owner
        await this.sendRevenueAlert(amount, type, userId);
    }

    async sendRevenueAlert(amount, type, userId) {
        const dailyRevenue = await this.getDailyRevenue();
        const subject = `💰 SoulMate Connect: $${(amount/100).toFixed(2)} - ${type}`;
        
        const html = `
            <h2>💰 NEW PAYMENT RECEIVED!</h2>
            <p><strong>Amount:</strong> $${(amount/100).toFixed(2)}</p>
            <p><strong>Type:</strong> ${type}</p>
            <p><strong>User ID:</strong> ${userId}</p>
            <p><strong>Today's Total:</strong> $${dailyRevenue.toFixed(2)}</p>
            <p><strong>Daily Target:</strong> $${this.targetDaily.toFixed(2)}</p>
            <p><strong>Progress:</strong> ${((dailyRevenue/this.targetDaily)*100).toFixed(1)}%</p>
        `;

        await this.emailTransporter.sendMail({
            from: process.env.FROM_EMAIL,
            to: process.env.OWNER_EMAIL,
            subject,
            html
        });
    }

    async getDailyRevenue() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const revenues = await Revenue.find({
            timestamp: { $gte: today }
        });
        
        return revenues.reduce((total, rev) => total + rev.amount, 0);
    }

    getPriceAmount(priceId) {
        const prices = {
            'price_premium_monthly': 2999, // $29.99
            'price_elite_monthly': 4999,   // $49.99
            'price_platinum_monthly': 9999 // $99.99
        };
        return prices[priceId] || 0;
    }

    async generateDailyReport() {
        const revenue = await this.getDailyRevenue();
        const userStats = await this.getUserStats();
        
        const report = {
            date: new Date().toISOString().split('T')[0],
            revenue,
            target: this.targetDaily,
            progress: (revenue / this.targetDaily) * 100,
            ...userStats
        };
        
        await this.sendDailyReport(report);
        return report;
    }

    async getUserStats() {
        const totalUsers = await User.countDocuments();
        const premiumUsers = await User.countDocuments({ subscriptionTier: { $ne: 'free' } });
        const verifiedUsers = await User.countDocuments({ isVerified: true });
        
        return {
            totalUsers,
            premiumUsers,
            verifiedUsers,
            conversionRate: totalUsers > 0 ? (premiumUsers / totalUsers) * 100 : 0
        };
    }

    async sendDailyReport(report) {
        const html = `
            <h1>📊 SoulMate Connect Daily Report</h1>
            <h2>💰 Revenue: $${report.revenue.toFixed(2)}</h2>
            <p>Target: $${report.target.toFixed(2)} (${report.progress.toFixed(1)}%)</p>
            
            <h3>📈 User Metrics</h3>
            <ul>
                <li>Total Users: ${report.totalUsers}</li>
                <li>Premium Users: ${report.premiumUsers}</li>
                <li>Verified Users: ${report.verifiedUsers}</li>
                <li>Conversion Rate: ${report.conversionRate.toFixed(1)}%</li>
            </ul>
            
            <h3>🎯 Action Items</h3>
            <ul>
                <li>Follow up with free users for premium conversion</li>
                <li>Send engagement emails to inactive users</li>
                <li>A/B test premium feature highlights</li>
            </ul>
        `;

        await this.emailTransporter.sendMail({
            from: process.env.FROM_EMAIL,
            to: process.env.OWNER_EMAIL,
            subject: `📊 Daily Report - $${report.revenue.toFixed(2)}`,
            html
        });
    }
}

module.exports = { MatchingService, RevenueService };


// backend/routes/ai.js
const express = require('express');
const router = express.Router();
const { authenticateToken, requirePremium } = require('../middleware/auth');
const AIService = require('../services/AIService');

const aiService = new AIService();

// AI Relationship Coaching (Premium Feature)
router.post('/coaching/conversation', authenticateToken, requirePremium, async (req, res) => {
    try {
        const { matchId, messages } = req.body;
        const advice = await aiService.analyzeConversation(req.user.id, matchId, messages);
        res.json({ success: true, advice });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// AI Compatibility Insights
router.get('/insights/:matchId', authenticateToken, requirePremium, async (req, res) => {
    try {
        const insights = await aiService.getCompatibilityInsights(req.user.id, req.params.matchId);
        res.json({ success: true, insights });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// AI Red Flag Detection
router.post('/safety/analyze', authenticateToken, async (req, res) => {
    try {
        const { profileData, messages } = req.body;
        const analysis = await aiService.analyzeSafetyRisks(profileData, messages);
        res.json({ success: true, analysis });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// AI Conversation Starters
router.get('/conversation-starters/:matchId', authenticateToken, async (req, res) => {
    try {
        const starters = await aiService.generateConversationStarters(req.user.id, req.params.matchId);
        res.json({ success: true, starters });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;

// backend/services/AIService.js
const OpenAI = require('openai');
const User = require('../models/User');
const Match = require('../models/Match');

class AIService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }

    async analyzeConversation(userId, matchId, messages) {
        try {
            const user = await User.findById(userId);
            const match = await User.findById(matchId);
            
            const prompt = `Analyze this dating conversation for relationship coaching:

User 1 Personality: ${JSON.stringify(user.personalityTraits)}
User 2 Personality: ${JSON.stringify(match.personalityTraits)}

Recent Messages: ${JSON.stringify(messages.slice(-10))}

Provide specific advice on:
1. Conversation flow and engagement
2. Compatibility indicators
3. Red flags or concerns
4. Next conversation topics
5. Relationship progression suggestions

Be encouraging but realistic.`;

            const response = await this.openai.chat.completions.create({
                model: "gpt-4",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 400,
                temperature: 0.7
            });

            return {
                advice: response.choices[0].message.content,
                timestamp: new Date(),
                type: 'conversation_analysis'
            };
        } catch (error) {
            console.error('AI conversation analysis error:', error);
            throw new Error('Unable to analyze conversation');
        }
    }

    async getCompatibilityInsights(userId, matchId) {
        try {
            const user = await User.findById(userId);
            const match = await User.findById(matchId);
            
            const prompt = `Generate detailed compatibility insights for these two people:

Person 1: 
- Personality: ${JSON.stringify(user.personalityTraits)}
- Interests: ${user.interests?.join(', ')}
- Lifestyle: ${JSON.stringify(user.lifestyle)}
- Values: ${user.values?.join(', ')}

Person 2:
- Personality: ${JSON.stringify(match.personalityTraits)}
- Interests: ${match.interests?.join(', ')}
- Lifestyle: ${JSON.stringify(match.lifestyle)}
- Values: ${match.values?.join(', ')}

Provide insights on:
1. Why you're compatible (3-4 specific reasons)
2. Potential challenges and how to overcome them
3. Relationship success probability (percentage)
4. Timeline prediction for relationship milestones
5. Communication style recommendations

Be specific and actionable.`;

            const response = await this.openai.chat.completions.create({
                model: "gpt-4",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 500,
                temperature: 0.8
            });

            return {
                insights: response.choices[0].message.content,
                compatibilityScore: this.calculateDetailedCompatibility(user, match),
                generatedAt: new Date()
            };
        } catch (error) {
            console.error('AI insights error:', error);
            throw new Error('Unable to generate insights');
        }
    }

    async analyzeSafetyRisks(profileData, messages = []) {
        try {
            const prompt = `Analyze this dating profile and messages for potential safety risks:

Profile Data: ${JSON.stringify(profileData)}
Recent Messages: ${JSON.stringify(messages)}

Look for red flags including:
- Manipulative language patterns
- Love bombing or excessive flattery
- Requests for personal information too quickly
- Financial requests or job offers
- Inconsistent story details
- Aggressive or controlling language
- Signs of catfishing

Provide:
1. Risk level (LOW/MEDIUM/HIGH)
2. Specific concerns found
3. Safety recommendations
4. Whether to recommend blocking/reporting

Be thorough but not paranoid.`;

            const response = await this.openai.chat.completions.create({
                model: "gpt-4",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 300,
                temperature: 0.3
            });

            const analysis = response.choices[0].message.content;
            const riskLevel = this.extractRiskLevel(analysis);

            return {
                analysis,
                riskLevel,
                timestamp: new Date(),
                requiresReview: riskLevel === 'HIGH'
            };
        } catch (error) {
            console.error('AI safety analysis error:', error);
            return {
                analysis: 'Unable to analyze safety risks at this time.',
                riskLevel: 'UNKNOWN',
                timestamp: new Date(),
                requiresReview: true
            };
        }
    }

    async generateConversationStarters(userId, matchId) {
        try {
            const user = await User.findById(userId);
            const match = await User.findById(matchId);
            
            const prompt = `Generate 5 personalized conversation starters for these matched users:

User 1: 
- Interests: ${user.interests?.join(', ')}
- Hobbies: ${user.hobbies?.join(', ')}
- Personality: ${JSON.stringify(user.personalityTraits)}

User 2:
- Interests: ${match.interests?.join(', ')}
- Hobbies: ${match.hobbies?.join(', ')}
- Personality: ${JSON.stringify(match.personalityTraits)}

Create engaging, specific questions that:
1. Reference shared interests
2. Show genuine curiosity
3. Encourage detailed responses
4. Feel natural and conversational
5. Help build connection

Format as a simple list.`;

            const response = await this.openai.chat.completions.create({
                model: "gpt-4",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 250,
                temperature: 0.9
            });

            const starters = response.choices[0].message.content
                .split('\n')
                .filter(line => line.trim())
                .slice(0, 5);

            return starters;
        } catch (error) {
            console.error('AI conversation starters error:', error);
            return [
                "What's been the highlight of your week so far?",
                "I noticed we both enjoy [shared interest] - what got you into that?",
                "If you could travel anywhere right now, where would you go?",
                "What's something you're passionate about that might surprise me?",
                "What's your ideal way to spend a Sunday?"
            ];
        }
    }

    calculateDetailedCompatibility(user1, user2) {
        // Enhanced compatibility calculation
        const personalityWeight = 0.4;
        const interestsWeight = 0.2;
        const lifestyleWeight = 0.2;
        const valuesWeight = 0.2;

        const personalityScore = this.calculatePersonalityCompatibility(
            user1.personalityTraits, 
            user2.personalityTraits
        );
        
        const interestsScore = this.calculateSharedInterests(
            user1.interests || [], 
            user2.interests || []
        );
        
        const lifestyleScore = this.calculateLifestyleCompatibility(
            user1.lifestyle || {}, 
            user2.lifestyle || {}
        );
        
        const valuesScore = this.calculateSharedValues(
            user1.values || [], 
            user2.values || []
        );

        return Math.round(
            personalityScore * personalityWeight +
            interestsScore * interestsWeight +
            lifestyleScore * lifestyleWeight +
            valuesScore * valuesWeight
        );
    }

    calculatePersonalityCompatibility(traits1, traits2) {
        const weights = {
            openness: 0.15,
            conscientiousness: 0.20,
            extraversion: 0.18,
            agreeableness: 0.25,
            neuroticism: 0.12,
            emotionalIntelligence: 0.10
        };

        let totalScore = 0;
        for (const [trait, weight] of Object.entries(weights)) {
            const diff = Math.abs((traits1[trait] || 50) - (traits2[trait] || 50));
            const score = Math.max(0, 100 - diff * 2); // Penalty for large differences
            totalScore += score * weight;
        }

        return totalScore;
    }

    calculateSharedInterests(interests1, interests2) {
        if (interests1.length === 0 || interests2.length === 0) return 50;
        
        const shared = interests1.filter(interest => 
            interests2.includes(interest)
        ).length;
        
        const total = new Set([...interests1, ...interests2]).size;
        return (shared / total) * 100;
    }

    calculateLifestyleCompatibility(lifestyle1, lifestyle2) {
        const factors = ['exerciseFrequency', 'drinkingHabits', 'socialLevel', 'sleepSchedule'];
        let compatibilitySum = 0;
        let factorCount = 0;

        factors.forEach(factor => {
            if (lifestyle1[factor] && lifestyle2[factor]) {
                const diff = Math.abs(lifestyle1[factor] - lifestyle2[factor]);
                compatibilitySum += Math.max(0, 100 - diff * 20);
                factorCount++;
            }
        });

        return factorCount > 0 ? compatibilitySum / factorCount : 75;
    }

    calculateSharedValues(values1, values2) {
        if (values1.length === 0 || values2.length === 0) return 50;
        
        const shared = values1.filter(value => values2.includes(value)).length;
        const maxValues = Math.max(values1.length, values2.length);
        
        return (shared / maxValues) * 100;
    }

    extractRiskLevel(analysis) {
        const text = analysis.toLowerCase();
        if (text.includes('high') && text.includes('risk')) return 'HIGH';
        if (text.includes('medium') && text.includes('risk')) return 'MEDIUM';
        return 'LOW';
    }
}

module.exports = AIService;


// backend/routes/admin.js
const express = require('express');
const router = express.Router();
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const AdminService = require('../services/AdminService');
const RevenueService = require('../services/RevenueService');

const adminService = new AdminService();
const revenueService = new RevenueService();

// Revenue Dashboard
router.get('/revenue/dashboard', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const dashboard = await adminService.getRevenueDashboard();
        res.json({ success: true, dashboard });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Daily Revenue Report
router.get('/revenue/daily', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const report = await revenueService.generateDailyReport();
        res.json({ success: true, report });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// User Management
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 50, filter } = req.query;
        const users = await adminService.getUsers(page, limit, filter);
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ban/Unban User
router.post('/users/:userId/ban', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { reason } = req.body;
        await adminService.banUser(req.params.userId, reason, req.user.id);
        res.json({ success: true, message: 'User banned successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Safety Reports
router.get('/safety/reports', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const reports = await adminService.getSafetyReports();
        res.json({ success: true, reports });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Process Safety Report
router.post('/safety/reports/:reportId/process', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { action, notes } = req.body;
        await adminService.processSafetyReport(req.params.reportId, action, notes, req.user.id);
        res.json({ success: true, message: 'Report processed successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;

// backend/services/AdminService.js
const User = require('../models/User');
const Revenue = require('../models/Revenue');
const SafetyReport = require('../models/SafetyReport');
const nodemailer = require('nodemailer');

class AdminService {
    constructor() {
        this.emailTransporter = nodemailer.createTransporter({
            service: 'gmail',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
    }

    async getRevenueDashboard() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        
        const thisWeek = new Date(today);
        thisWeek.setDate(thisWeek.getDate() - 7);
        
        const thisMonth = new Date(today);
        thisMonth.setMonth(thisMonth.getMonth() - 1);

        const [dailyRevenue, weeklyRevenue, monthlyRevenue, userStats] = await Promise.all([
            this.getRevenueForPeriod(today),
            this.getRevenueForPeriod(thisWeek),
            this.getRevenueForPeriod(thisMonth),
            this.getUserStatistics()
        ]);

        return {
            daily: dailyRevenue,
            weekly: weeklyRevenue,
            monthly: monthlyRevenue,
            users: userStats,
            targetDaily: 23333,
            targetMonthly: 700000,
            progress: (monthlyRevenue.total / 700000) * 100
        };
    }

    async getRevenueForPeriod(startDate) {
        const revenues = await Revenue.find({
            timestamp: { $gte: startDate }
        });

        const byType = revenues.reduce((acc, rev) => {
            acc[rev.type] = (acc[rev.type] || 0) + rev.amount;
            return acc;
        }, {});

        return {
            total: revenues.reduce((sum, rev) => sum + rev.amount, 0),
            byType,
            count: revenues.length
        };
    }

    async getUserStatistics() {
        const [total, premium, verified, active] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ subscriptionTier: { $ne: 'free' } }),
            User.countDocuments({ isVerified: true }),
            User.countDocuments({ lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } })
        ]);

        return {
            total,
            premium,
            verified,
            active,
            conversionRate: total > 0 ? (premium / total) * 100 : 0,
            verificationRate: total > 0 ? (verified / total) * 100 : 0
        };
    }

    async getUsers(page = 1, limit = 50, filter = {}) {
        const skip = (page - 1) * limit;
        const query = {};

        if (filter.subscriptionTier) query.subscriptionTier = filter.subscriptionTier;
        if (filter.isVerified !== undefined) query.isVerified = filter.isVerified;
        if (filter.isBanned !== undefined) query.isBanned = filter.isBanned;

        const users = await User.find(query)
            .select('-password')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const total = await User.countDocuments(query);

        return {
            users,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        };
    }

    async banUser(userId, reason, adminId) {
        await User.findByIdAndUpdate(userId, {
            isBanned: true,
            banReason: reason,
            bannedBy: adminId,
            bannedAt: new Date()
        });

        // Send notification email to owner
        await this.emailTransporter.sendMail({
            from: process.env.FROM_EMAIL,
            to: process.env.OWNER_EMAIL,
            subject: '🚨 User Banned - SoulMate Connect',
            html: `
                <h2>🚨 User Banned</h2>
                <p><strong>User ID:</strong> ${userId}</p>
                <p><strong>Reason:</strong> ${reason}</p>
                <p><strong>Banned by Admin:</strong> ${adminId}</p>
                <p><strong>Time:</strong> ${new Date().toISOString()}</p>
            `
        });
    }

    async getSafetyReports() {
        return await SafetyReport.find()
            .populate('reportedBy', 'firstName lastName email')
            .populate('reportedUser', 'firstName lastName email')
            .sort({ createdAt: -1 })
            .limit(100);
    }

    async processSafetyReport(reportId, action, notes, adminId) {
        const report = await SafetyReport.findById(reportId);
        if (!report) throw new Error('Report not found');

        if (action === 'ban') {
            await this.banUser(report.reportedUser, `Safety report: ${report.reason}`, adminId);
        }

        await SafetyReport.findByIdAndUpdate(reportId, {
            status: action === 'ban' ? 'resolved_banned' : 'resolved_dismissed',
            processedBy: adminId,
            processedAt: new Date(),
            adminNotes: notes
        });
    }
}

// backend/services/SafetyService.js
const SafetyReport = require('../models/SafetyReport');
const User = require('../models/User');
const AIService = require('./AIService');

class SafetyService {
    constructor() {
        this.aiService = new AIService();
    }

    async reportUser(reportedBy, reportedUser, reason, evidence = {}) {
        const report = new SafetyReport({
            reportedBy,
            reportedUser,
            reason,
            evidence,
            status: 'pending'
        });

        await report.save();

        // Auto-analyze with AI
        const analysis = await this.aiService.analyzeSafetyRisks(evidence);
        
        if (analysis.riskLevel === 'HIGH') {
            // Immediately suspend user for review
            await User.findByIdAndUpdate(reportedUser, {
                isActive: false,
                suspendedForReview: true
            });

            // Alert admin immediately
            await this.alertAdmin(report, analysis);
        }

        return report;
    }

    async alertAdmin(report, analysis) {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransporter({
            service: 'gmail',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        await transporter.sendMail({
            from: process.env.FROM_EMAIL,
            to: process.env.OWNER_EMAIL,
            subject: '🚨 HIGH RISK USER ALERT - SoulMate Connect',
            html: `
                <h1>🚨 HIGH RISK USER DETECTED</h1>
                <p><strong>Report ID:</strong> ${report._id}</p>
                <p><strong>Reported User:</strong> ${report.reportedUser}</p>
                <p><strong>Risk Level:</strong> ${analysis.riskLevel}</p>
                <p><strong>Reason:</strong> ${report.reason}</p>
                <p><strong>AI Analysis:</strong> ${analysis.analysis}</p>
                <p><strong>Action Taken:</strong> User temporarily suspended</p>
                <p><a href="${process.env.ADMIN_URL}/safety/reports/${report._id}">Review Report</a></p>
            `
        });
    }

    async verifyID(userId, idDocument) {
        // Simple ID verification - in production use proper service like Jumio
        const isValid = await this.validateIDDocument(idDocument);
        
        if (isValid) {
            await User.findByIdAndUpdate(userId, {
                isVerified: true,
                verifiedAt: new Date()
            });
            return { verified: true };
        }
        
        return { verified: false, reason: 'Invalid or unclear ID document' };
    }

    async validateIDDocument(document) {
        // Placeholder - integrate with real ID verification service
        // For MVP, just check if document exists and has reasonable size
        return document && document.size > 50000 && document.size < 10000000;
    }

    async checkUserSafety(userId) {
        const user = await User.findById(userId);
        const reports = await SafetyReport.find({ reportedUser: userId });
        
        const riskFactors = {
            multipleReports: reports.length > 2,
            recentReports: reports.some(r => 
                new Date() - r.createdAt < 7 * 24 * 60 * 60 * 1000
            ),
            unverified: !user.isVerified,
            newAccount: new Date() - user.createdAt < 24 * 60 * 60 * 1000
        };

        const riskScore = Object.values(riskFactors).filter(Boolean).length;
        
        return {
            riskLevel: riskScore >= 3 ? 'HIGH' : riskScore >= 2 ? 'MEDIUM' : 'LOW',
            riskFactors,
            recommendations: this.getSafetyRecommendations(riskScore)
        };
    }

    getSafetyRecommendations(riskScore) {
        if (riskScore >= 3) {
            return [
                'Meet in public places only',
                'Tell friends about your date plans',
                'Video chat before meeting',
                'Use the app\'s built-in calling feature'
            ];
        } else if (riskScore >= 2) {
            return [
                'Video chat before meeting',
                'Meet in public places',
                'Trust your instincts'
            ];
        } else {
            return [
                'Follow standard dating safety practices',
                'Meet in public for first dates'
            ];
        }
    }
}

module.exports = { AdminService, SafetyService };





// backend/middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId).select('-password');
        
        if (!user || user.isBanned) {
            return res.status(403).json({ error: 'User not found or banned' });
        }

        req.user = user;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

const requirePremium = (req, res, next) => {
    if (req.user.subscriptionTier === 'free') {
        return res.status(402).json({ 
            error: 'Premium subscription required',
            upgradeUrl: '/premium'
        });
    }
    next();
};

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

const requireVerification = (req, res, next) => {
    if (!req.user.isVerified) {
        return res.status(402).json({ 
            error: 'ID verification required',
            verifyUrl: '/verify'
        });
    }
    next();
};

const rateLimiter = (maxRequests = 100, windowMs = 15 * 60 * 1000) => {
    const requests = new Map();
    
    return (req, res, next) => {
        const key = req.ip + (req.user ? req.user.id : '');
        const now = Date.now();
        const windowStart = now - windowMs;
        
        const userRequests = requests.get(key) || [];
        const validRequests = userRequests.filter(time => time > windowStart);
        
        if (validRequests.length >= maxRequests) {
            return res.status(429).json({ 
                error: 'Too many requests',
                retryAfter: Math.ceil(windowMs / 1000)
            });
        }
        
        validRequests.push(now);
        requests.set(key, validRequests);
        next();
    };
};

module.exports = {
    authenticateToken,
    requirePremium,
    requireAdmin,
    requireVerification,
    rateLimiter
};

// backend/utils/validation.js
const validator = require('validator');

const validateEmail = (email) => {
    return validator.isEmail(email);
};

const validatePassword = (password) => {
    const minLength = 8;
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChar = /[!@#$%^&*]/.test(password);
    
    return {
        isValid: password.length >= minLength && hasUpperCase && hasLowerCase && hasNumbers,
        errors: [
            password.length < minLength && `Minimum ${minLength} characters required`,
            !hasUpperCase && 'Must contain uppercase letter',
            !hasLowerCase && 'Must contain lowercase letter',
            !hasNumbers && 'Must contain number',
            !hasSpecialChar && 'Special character recommended'
        ].filter(Boolean)
    };
};

const validateAge = (birthDate) => {
    const age = Math.floor((new Date() - new Date(birthDate)) / (365.25 * 24 * 60 * 60 * 1000));
    return age >= 18 && age <= 100;
};

const validatePersonalityTraits = (traits) => {
    const requiredTraits = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];
    
    for (const trait of requiredTraits) {
        if (!traits[trait] || traits[trait] < 0 || traits[trait] > 100) {
            return false;
        }
    }
    return true;
};

const sanitizeInput = (input) => {
    if (typeof input !== 'string') return input;
    return validator.escape(input.trim());
};

const validateProfileData = (data) => {
    const errors = [];
    
    if (!data.firstName || data.firstName.length < 2) {
        errors.push('First name must be at least 2 characters');
    }
    
    if (!data.lastName || data.lastName.length < 2) {
        errors.push('Last name must be at least 2 characters');
    }
    
    if (!validateEmail(data.email)) {
        errors.push('Valid email address required');
    }
    
    if (!validateAge(data.birthDate)) {
        errors.push('Must be between 18 and 100 years old');
    }
    
    if (!validatePersonalityTraits(data.personalityTraits)) {
        errors.push('Complete personality assessment required');
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
};

module.exports = {
    validateEmail,
    validatePassword,
    validateAge,
    validatePersonalityTraits,
    sanitizeInput,
    validateProfileData
};

// backend/utils/helpers.js
const crypto = require('crypto');
const sharp = require('sharp');
const AWS = require('aws-sdk');

// Configure AWS S3
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

const generateSecureToken = (length = 32) => {
    return crypto.randomBytes(length).toString('hex');
};

const hashString = (str, salt = null) => {
    if (!salt) salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(str, salt, 1000, 64, 'sha512').toString('hex');
    return { hash, salt };
};

const verifyHash = (str, hash, salt) => {
    const verifyHash = crypto.pbkdf2Sync(str, salt, 1000, 64, 'sha512').toString('hex');
    return hash === verifyHash;
};

const calculateAge = (birthDate) => {
    return Math.floor((new Date() - new Date(birthDate)) / (365.25 * 24 * 60 * 60 * 1000));
};

const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 3959; // Earth's radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
};

const optimizeImage = async (buffer, options = {}) => {
    const {
        width = 800,
        height = 800,
        quality = 80,
        format = 'jpeg'
    } = options;

    return await sharp(buffer)
        .resize(width, height, { fit: 'cover' })
        .jpeg({ quality })
        .toBuffer();
};

const uploadToS3 = async (buffer, key, contentType = 'image/jpeg') => {
    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ACL: 'public-read'
    };

    const result = await s3.upload(params).promise();
    return result.Location;
};

const generateReferralCode = (userId) => {
    const hash = crypto.createHash('md5').update(userId + Date.now()).digest('hex');
    return hash.substring(0, 8).toUpperCase();
};

const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
    }).format(amount);
};

const generateMatchId = (userId1, userId2) => {
    const sortedIds = [userId1, userId2].sort();
    return crypto.createHash('md5').update(sortedIds.join('')).digest('hex');
};

const isBusinessHours = () => {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();
    
    // Monday-Friday, 9 AM - 6 PM EST
    return day >= 1 && day <= 5 && hour >= 9 && hour <= 18;
};

const scheduleTask = (task, delayMs) => {
    return setTimeout(task, delayMs);
};

const formatPhoneNumber = (phone) => {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) {
        return `(${cleaned.slice(0,3)}) ${cleaned.slice(3,6)}-${cleaned.slice(6)}`;
    }
    return phone;
};

const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

const maskEmail = (email) => {
    const [username, domain] = email.split('@');
    if (username.length <= 2) return email;
    
    const masked = username.slice(0, 2) + '*'.repeat(username.length - 2);
    return `${masked}@${domain}`;
};

const logError = (error, context = {}) => {
    console.error(`[${new Date().toISOString()}] Error:`, {
        message: error.message,
        stack: error.stack,
        context
    });
};

const generateUniqueId = () => {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
};

module.exports = {
    generateSecureToken,
    hashString,
    verifyHash,
    calculateAge,
    calculateDistance,
    optimizeImage,
    uploadToS3,
    generateReferralCode,
    formatCurrency,
    generateMatchId,
    isBusinessHours,
    scheduleTask,
    formatPhoneNumber,
    generateOTP,
    maskEmail,
    logError,
    generateUniqueId
};

// backend/models/SafetyReport.js
const mongoose = require('mongoose');

const safetyReportSchema = new mongoose.Schema({
    reportedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    reportedUser: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    reason: {
        type: String,
        required: true,
        enum: [
            'inappropriate_behavior',
            'harassment',
            'fake_profile',
            'spam',
            'abuse',
            'catfish',
            'underage',
            'other'
        ]
    },
    description: {
        type: String,
        required: true,
        maxlength: 1000
    },
    evidence: {
        screenshots: [String],
        messages: [String],
        additionalInfo: String
    },
    status: {
        type: String,
        enum: ['pending', 'investigating', 'resolved_banned', 'resolved_warning', 'resolved_dismissed'],
        default: 'pending'
    },
    processedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    processedAt: Date,
    adminNotes: String,
    aiAnalysis: {
        riskLevel: String,
        analysis: String,
        confidence: Number
    }
}, {
    timestamps: true
});

safetyReportSchema.index({ reportedUser: 1, status: 1 });
safetyReportSchema.index({ createdAt: -1 });

module.exports = mongoose.model('SafetyReport', safetyReportSchema);

// frontend/src/components/Register.js
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Container, Paper, TextField, Button, Typography, Box,
    Stepper, Step, StepLabel, Slider, FormControlLabel,
    Checkbox, Alert, CircularProgress, Grid
} from '@mui/material';
import { useAuth } from '../utils/auth';
import axios from 'axios';

const steps = ['Basic Info', 'Personality Assessment', 'Preferences'];

const personalityTraits = [
    { key: 'openness', label: 'Openness to Experience', description: 'Curious, creative, open to new ideas' },
    { key: 'conscientiousness', label: 'Conscientiousness', description: 'Organized, responsible, dependable' },
    { key: 'extraversion', label: 'Extraversion', description: 'Outgoing, energetic, social' },
    { key: 'agreeableness', label: 'Agreeableness', description: 'Cooperative, trusting, helpful' },
    { key: 'neuroticism', label: 'Emotional Stability', description: 'Calm, secure, confident' }
];

function Register() {
    const navigate = useNavigate();
    const { login } = useAuth();
    const [activeStep, setActiveStep] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    
    const [formData, setFormData] = useState({
        firstName: '',
        lastName: '',
        email: '',
        password: '',
        confirmPassword: '',
        birthDate: '',
        gender: '',
        lookingFor: '',
        personalityTraits: {
            openness: 50,
            conscientiousness: 50,
            extraversion: 50,
            agreeableness: 50,
            neuroticism: 50
        },
        dealBreakers: {
            smoking: false,
            hasKids: false,
            pets: false
        },
        interests: [],
        location: { lat: 0, lng: 0 }
    });

    const handleNext = () => {
        if (validateStep(activeStep)) {
            setActiveStep(prev => prev + 1);
        }
    };

    const handleBack = () => {
        setActiveStep(prev => prev - 1);
    };

    const validateStep = (step) => {
        switch (step) {
            case 0:
                return formData.firstName && formData.lastName && formData.email && 
                       formData.password === formData.confirmPassword && formData.birthDate;
            case 1:
                return Object.values(formData.personalityTraits).every(val => val > 0);
            case 2:
                return formData.gender && formData.lookingFor;
            default:
                return false;
        }
    };

    const handleSubmit = async () => {
        setLoading(true);
        setError('');
        
        try {
            const response = await axios.post('/auth/register', formData);
            await login(response.data.token);
            navigate('/verify'); // Redirect to ID verification
        } catch (error) {
            setError(error.response?.data?.error || 'Registration failed');
        } finally {
            setLoading(false);
        }
    };

    const renderStepContent = (step) => {
        switch (step) {
            case 0:
                return (
                    <Grid container spacing={3}>
                        <Grid item xs={12} sm={6}>
                            <TextField
                                fullWidth
                                label="First Name"
                                value={formData.firstName}
                                onChange={(e) => setFormData({...formData, firstName: e.target.value})}
                                required
                            />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField
                                fullWidth
                                label="Last Name"
                                value={formData.lastName}
                                onChange={(e) => setFormData({...formData, lastName: e.target.value})}
                                required
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField
                                fullWidth
                                type="email"
                                label="Email Address"
                                value={formData.email}
                                onChange={(e) => setFormData({...formData, email: e.target.value})}
                                required
                            />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField
                                fullWidth
                                type="password"
                                label="Password"
                                value={formData.password}
                                onChange={(e) => setFormData({...formData, password: e.target.value})}
                                required
                            />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField
                                fullWidth
                                type="password"
                                label="Confirm Password"
                                value={formData.confirmPassword}
                                onChange={(e) => setFormData({...formData, confirmPassword: e.target.value})}
                                required
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField
                                fullWidth
                                type="date"
                                label="Birth Date"
                                value={formData.birthDate}
                                onChange={(e) => setFormData({...formData, birthDate: e.target.value})}
                                InputLabelProps={{ shrink: true }}
                                required
                            />
                        </Grid>
                    </Grid>
                );
            
            case 1:
                return (
                    <Box>
                        <Typography variant="h6" gutterBottom>
                            Tell us about your personality
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                            Move the sliders to reflect how you see yourself. This helps us find your perfect match!
                        </Typography>
                        {personalityTraits.map((trait) => (
                            <Box key={trait.key} sx={{ mb: 4 }}>
                                <Typography gutterBottom>
                                    {trait.label}
                                </Typography>
                                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                                    {trait.description}
                                </Typography>
                                <Slider
                                    value={formData.personalityTraits[trait.key]}
                                    onChange={(e, value) => setFormData({
                                        ...formData,
                                        personalityTraits: {
                                            ...formData.personalityTraits,
                                            [trait.key]: value
                                        }
                                    })}
                                    min={0}
                                    max={100}
                                    valueLabelDisplay="auto"
                                    marks={[
                                        { value: 0, label: 'Low' },
                                        { value: 50, label: 'Moderate' },
                                        { value: 100, label: 'High' }
                                    ]}
                                />
                            </Box>
                        ))}
                    </Box>
                );
            
            case 2:
                return (
                    <Grid container spacing={3}>
                        <Grid item xs={12} sm={6}>
                            <TextField
                                fullWidth
                                select
                                label="I am"
                                value={formData.gender}
                                onChange={(e) => setFormData({...formData, gender: e.target.value})}
                                SelectProps={{ native: true }}
                                required
                            >
                                <option value=""></option>
                                <option value="man">Man</option>
                                <option value="woman">Woman</option>
                                <option value="non-binary">Non-binary</option>
                            </TextField>
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField
                                fullWidth
                                select
                                label="Looking for"
                                value={formData.lookingFor}
                                onChange={(e) => setFormData({...formData, lookingFor: e.target.value})}
                                SelectProps={{ native: true }}
                                required
                            >
                                <option value=""></option>
                                <option value="men">Men</option>
                                <option value="women">Women</option>
                                <option value="everyone">Everyone</option>
                            </TextField>
                        </Grid>
                        <Grid item xs={12}>
                            <Typography variant="h6" gutterBottom>
                                Deal Breakers
                            </Typography>
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                Select what you absolutely cannot accept in a partner:
                            </Typography>
                            <FormControlLabel
                                control={
                                    <Checkbox
                                        checked={formData.dealBreakers.smoking}
                                        onChange={(e) => setFormData({
                                            ...formData,
                                            dealBreakers: {
                                                ...formData.dealBreakers,
                                                smoking: e.target.checked
                                            }
                                        })}
                                    />
                                }
                                label="Smoking"
                            />
                            <FormControlLabel
                                control={
                                    <Checkbox
                                        checked={formData.dealBreakers.hasKids}
                                        onChange={(e) => setFormData({
                                            ...formData,
                                            dealBreakers: {
                                                ...formData.dealBreakers,
                                                hasKids: e.target.checked
                                            }
                                        })}
                                    />
                                }
                                label="Has Children"
                            />
                            <FormControlLabel
                                control={
                                    <Checkbox
                                        checked={formData.dealBreakers.pets}
                                        onChange={(e) => setFormData({
                                            ...formData,
                                            dealBreakers: {
                                                ...formData.dealBreakers,
                                                pets: e.target.checked
                                            }
                                        })}
                                    />
                                }
                                label="Has Pets"
                            />
                        </Grid>
                    </Grid>
                );
            
            default:
                return null;
        }
    };

    return (
        <Container maxWidth="md" sx={{ py: 4 }}>
            <Paper elevation={3} sx={{ p: 4 }}>
                <Typography variant="h4" align="center" gutterBottom>
                    Join SoulMate Connect
                </Typography>
                <Typography variant="body1" align="center" color="text.secondary" sx={{ mb: 4 }}>
                    Find your 1 in 10,000 perfect match
                </Typography>

                <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
                    {steps.map((label) => (
                        <Step key={label}>
                            <StepLabel>{label}</StepLabel>
                        </Step>
                    ))}
                </Stepper>

                {error && (
                    <Alert severity="error" sx={{ mb: 3 }}>
                        {error}
                    </Alert>
                )}

                <Box sx={{ mb: 4 }}>
                    {renderStepContent(activeStep)}
                </Box>

                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Button
                        disabled={activeStep === 0}
                        onClick={handleBack}
                    >
                        Back
                    </Button>
                    
                    {activeStep === steps.length - 1 ? (
                        <Button
                            variant="contained"
                            onClick={handleSubmit}
                            dis

...
