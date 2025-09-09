const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');
const Revenue = require('../models/Revenue');
const auth = require('../middleware/auth');
const router = express.Router();

// Create subscription
router.post('/create-subscription', auth, async (req, res) => {
  try {
    const { priceId, paymentMethodId } = req.body;
    const user = await User.findById(req.userId);

    // Create or retrieve customer
    let customer;
    if (user.subscription.stripeCustomerId) {
      customer = await stripe.customers.retrieve(user.subscription.stripeCustomerId);
    } else {
      customer = await stripe.customers.create({
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        payment_method: paymentMethodId,
        invoice_settings: { default_payment_method: paymentMethodId }
      });
      
      user.subscription.stripeCustomerId = customer.id;
    }

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent']
    });

    // Update user subscription
    user.subscription.stripeSubscriptionId = subscription.id;
    user.subscription.plan = priceId.includes('premium_plus') ? 'premium_plus' : 'premium';
    user.subscription.status = 'active';
    user.subscription.startDate = new Date();
    
    await user.save();

    res.json({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent.client_secret
    });
  } catch (error) {
    res.status(500).json({ message: 'Payment failed', error: error.message });
  }
});

// Webhook for payment processing
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed.`);
  }

  switch (event.type) {
    case 'invoice.payment_succeeded':
      const invoice = event.data.object;
      await recordRevenue(invoice);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionCancellation(event.data.object);
      break;
  }

  res.json({received: true});
});

async function recordRevenue(invoice) {
  const today = new Date().toISOString().split('T')[0];
  const amount = invoice.amount_paid / 100; // Convert from cents
  
  const ownerAmount = amount * (process.env.OWNER_PERCENTAGE / 100);
  const operatingAmount = amount * (process.env.OPERATING_PERCENTAGE / 100);

  await Revenue.findOneAndUpdate(
    { date: today },
    {
      $inc: {
        totalRevenue: amount,
        ownerAmount: ownerAmount,
        operatingAmount: operatingAmount,
        'breakdown.subscriptions': amount
      }
    },
    { upsert: true }
  );
}

module.exports = router;
