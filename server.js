require('dotenv').config();
const express      = require('express');
const bodyParser   = require('body-parser');
const cookieParser = require('cookie-parser');
const { Sequelize, DataTypes } = require('sequelize');
const passport     = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');

const app = express();
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(passport.initialize());

// Set up Sequelize with SSL options for PostgreSQL
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  }
});

// -----------------------
// Models
// -----------------------

// User model for authentication
const User = sequelize.define('User', {
  username: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  passwordHash: {
    type: DataTypes.STRING,
    allowNull: false
  }
});

// Giveaway model: each record has a room name, channel link, unique code, and referral count
const Giveaway = sequelize.define('Giveaway', {
  roomName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  channelLink: {
    type: DataTypes.STRING,
    allowNull: false
  },
  code: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    unique: true
  },
  referralCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  }
});

// Referral model: records the name and timestamp when someone joins a giveaway
const Referral = sequelize.define('Referral', {
  referrerName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  timestamp: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
});

// -----------------------
// Model Associations
// -----------------------
User.hasMany(Giveaway, { foreignKey: 'ownerId' });
Giveaway.belongsTo(User, { foreignKey: 'ownerId' });
Giveaway.hasMany(Referral, { foreignKey: 'giveawayId', as: 'referrals' });
Referral.belongsTo(Giveaway, { foreignKey: 'giveawayId' });

// -----------------------
// Passport Configuration
// -----------------------
passport.use(new LocalStrategy(
  async (username, password, done) => {
    try {
      const user = await User.findOne({ where: { username } });
      if (!user) return done(null, false, { message: 'Incorrect username.' });
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return done(null, false, { message: 'Incorrect password.' });
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

// -----------------------
// JWT Middleware
// -----------------------
function authenticateJWT(req, res, next) {
  const token = req.cookies.jwt;
  if (token) {
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) return res.redirect('/login');
      req.user = decoded;
      next();
    });
  } else {
    res.redirect('/login');
  }
}

// -----------------------
// Middleware to Make Request Data Available in Templates
// -----------------------
app.use((req, res, next) => {
  res.locals.user = req.user;
  res.locals.hostUrl = req.protocol + '://' + req.get('host');
  next();
});

// -----------------------
// Routes
// -----------------------

// Main page: Show all giveaway rooms with referral counts.
app.get('/', async (req, res) => {
  const giveaways = await Giveaway.findAll();
  res.render('index', { giveaways });
});

// Signup routes
app.get('/signup', (req, res) => {
  res.render('signup');
});
app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    await User.create({ username, passwordHash: hash });
    res.redirect('/login');
  } catch (err) {
    res.redirect('/signup');
  }
});

// Login routes (custom callback to issue JWT)
app.get('/login', (req, res) => {
  res.render('login');
});
app.post('/login', (req, res, next) => {
  passport.authenticate('local', { session: false }, (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.redirect('/login');
    // Generate JWT token
    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
    // Set token in HTTP-only cookie
    res.cookie('jwt', token, { httpOnly: true });
    res.redirect('/dashboard');
  })(req, res, next);
});

// Dashboard for giveaway creators: shows their giveaways and referral details.
app.get('/dashboard', authenticateJWT, async (req, res) => {
  const giveaways = await Giveaway.findAll({ 
    where: { ownerId: req.user.id },
    include: [{ model: Referral, as: 'referrals' }]
  });
  res.render('dashboard', { giveaways });
});

// Create giveaway (only for logged-in users)
app.get('/create-giveaway', authenticateJWT, (req, res) => {
  res.render('create_giveaway');
});
app.post('/create-giveaway', authenticateJWT, async (req, res) => {
  const { roomName, channelLink } = req.body;
  try {
    await Giveaway.create({ roomName, channelLink, ownerId: req.user.id });
    res.redirect('/dashboard');
  } catch (err) {
    res.redirect('/create-giveaway');
  }
});

// Giveaway join route: shows a form to input your name then registers the referral.
app.get('/giveaway/:code/join', async (req, res) => {
  const giveaway = await Giveaway.findOne({ where: { code: req.params.code } });
  if (!giveaway) return res.status(404).send('Giveaway not found.');
  res.render('join_giveaway', { giveaway });
});
app.post('/giveaway/:code/join', async (req, res) => {
  const giveaway = await Giveaway.findOne({ where: { code: req.params.code } });
  if (!giveaway) return res.status(404).send('Giveaway not found.');
  const { referrerName } = req.body;
  if (!referrerName) return res.redirect(`/giveaway/${req.params.code}/join`);
  await Referral.create({ giveawayId: giveaway.id, referrerName });
  giveaway.referralCount++;
  await giveaway.save();
  // Redirect visitor to the channel link.
  res.redirect(giveaway.channelLink);
});

// -----------------------
// Start the Server
// -----------------------
sequelize.sync().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
