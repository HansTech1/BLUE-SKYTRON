require('dotenv').config();
const express       = require('express');
const session       = require('express-session');
const bodyParser    = require('body-parser');
const { Sequelize, DataTypes } = require('sequelize');
const passport      = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt        = require('bcrypt');

const app = express();
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

// Session configuration (store secrets in .env in production)
app.use(session({
  secret: process.env.SESSION_SECRET || 'your_secret_key',
  resave: false,
  saveUninitialized: false,
}));

app.use(passport.initialize());
app.use(passport.session());

// Set up Sequelize with your PostgreSQL URI
const sequelize = new Sequelize(process.env.DATABASE_URL || 
  'postgresql://byte:kutv4hIe55KQ46Vg5LxIZtHfvJCQjYL1@dpg-cvai65an91rc73958hs0-a.oregon-postgres.render.com/hans_cjo2'
);

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
  // UUID generated code for unique referral URL
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

// A user can create many giveaways.
User.hasMany(Giveaway, { foreignKey: 'ownerId' });
Giveaway.belongsTo(User, { foreignKey: 'ownerId' });

// Each giveaway can have many referrals. Using alias 'referrals' for clarity.
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

passport.serializeUser((user, done) => {
  done(null, user.id);
});
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findByPk(id);
    done(null, user);
  } catch(err) {
    done(err);
  }
});

// -----------------------
// Middleware to Make Request Data Available in Templates
// -----------------------
app.use((req, res, next) => {
  res.locals.user = req.user;
  // For constructing full URLs in templates if needed.
  res.locals.hostUrl = req.protocol + '://' + req.get('host');
  next();
});

// -----------------------
// Routes
// -----------------------

// Main page: Show all giveaway rooms as buttons with referral counts.
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

// Login routes
app.get('/login', (req, res) => {
  res.render('login');
});
app.post('/login', passport.authenticate('local', {
  successRedirect: '/dashboard',
  failureRedirect: '/login'
}));

// Logout route
app.get('/logout', (req, res) => {
  req.logout(err => {
    if(err) return next(err);
    res.redirect('/');
  });
});

// Dashboard for giveaway creators: shows their giveaways and referral details.
app.get('/dashboard', ensureAuthenticated, async (req, res) => {
  const giveaways = await Giveaway.findAll({ 
    where: { ownerId: req.user.id },
    include: [{ model: Referral, as: 'referrals' }]
  });
  res.render('dashboard', { giveaways });
});

// Create giveaway (only for logged in users)
app.get('/create-giveaway', ensureAuthenticated, (req, res) => {
  res.render('create_giveaway');
});
app.post('/create-giveaway', ensureAuthenticated, async (req, res) => {
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
  if(!giveaway) return res.status(404).send('Giveaway not found.');
  res.render('join_giveaway', { giveaway });
});
app.post('/giveaway/:code/join', async (req, res) => {
  const giveaway = await Giveaway.findOne({ where: { code: req.params.code } });
  if(!giveaway) return res.status(404).send('Giveaway not found.');
  const { referrerName } = req.body;
  if(!referrerName) return res.redirect(`/giveaway/${req.params.code}/join`);
  // Create referral and increment counter.
  await Referral.create({ giveawayId: giveaway.id, referrerName });
  giveaway.referralCount++;
  await giveaway.save();
  // Redirect visitor to the channel link.
  res.redirect(giveaway.channelLink);
});

// Middleware: Ensure the user is authenticated.
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// -----------------------
// Start the Server
// -----------------------
sequelize.sync().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
