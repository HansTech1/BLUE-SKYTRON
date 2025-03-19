require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Sequelize, DataTypes } = require('sequelize');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');

const app = express();
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

app.use(passport.initialize());

// Database Connection
const sequelize = new Sequelize(process.env.DATABASE_URL);

// Models
const User = sequelize.define('User', {
  username: { type: DataTypes.STRING, unique: true, allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false }
});

const Giveaway = sequelize.define('Giveaway', {
  roomName: { type: DataTypes.STRING, allowNull: false },
  channelLink: { type: DataTypes.STRING, allowNull: false },
  code: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, unique: true },
  referralCount: { type: DataTypes.INTEGER, defaultValue: 0 }
});

const Referral = sequelize.define('Referral', {
  referrerName: { type: DataTypes.STRING, allowNull: false },
  timestamp: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

// Associations
User.hasMany(Giveaway, { foreignKey: 'ownerId' });
Giveaway.belongsTo(User, { foreignKey: 'ownerId' });
Giveaway.hasMany(Referral, { foreignKey: 'giveawayId', as: 'referrals' });
Referral.belongsTo(Giveaway, { foreignKey: 'giveawayId' });

// Passport Authentication
passport.use(new LocalStrategy(async (username, password, done) => {
  try {
    const user = await User.findOne({ where: { username } });
    if (!user) return done(null, false, { message: 'Incorrect username.' });
    if (!await bcrypt.compare(password, user.passwordHash)) return done(null, false, { message: 'Incorrect password.' });
    return done(null, user);
  } catch (err) { return done(err); }
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// Routes
app.get('/', async (req, res) => {
  const giveaways = await Giveaway.findAll();
  res.render('index', { giveaways });
});

app.get('/signup', (req, res) => res.render('signup'));
app.post('/signup', async (req, res) => {
  try {
    const hash = await bcrypt.hash(req.body.password, 10);
    await User.create({ username: req.body.username, passwordHash: hash });
    res.redirect('/login');
  } catch (err) { res.redirect('/signup'); }
});

app.get('/login', (req, res) => res.render('login'));
app.post('/login', passport.authenticate('local', { successRedirect: '/dashboard', failureRedirect: '/login' }));

app.get('/dashboard', ensureAuthenticated, async (req, res) => {
  const giveaways = await Giveaway.findAll({ where: { ownerId: req.user.id }, include: [{ model: Referral, as: 'referrals' }] });
  res.render('dashboard', { giveaways });
});

app.get('/create-giveaway', ensureAuthenticated, (req, res) => res.render('create_giveaway'));
app.post('/create-giveaway', ensureAuthenticated, async (req, res) => {
  await Giveaway.create({ roomName: req.body.roomName, channelLink: req.body.channelLink, ownerId: req.user.id });
  res.redirect('/dashboard');
});

app.get('/giveaway/:code/join', async (req, res) => {
  const giveaway = await Giveaway.findOne({ where: { code: req.params.code } });
  if (!giveaway) return res.status(404).send('Giveaway not found.');
  res.render('join_giveaway', { giveaway });
});

app.post('/giveaway/:code/join', async (req, res) => {
  const giveaway = await Giveaway.findOne({ where: { code: req.params.code } });
  if (!giveaway) return res.status(404).send('Giveaway not found.');
  await Referral.create({ giveawayId: giveaway.id, referrerName: req.body.referrerName });
  giveaway.referralCount++;
  await giveaway.save();
  res.redirect(giveaway.channelLink);
});

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

sequelize.sync().then(() => {
  app.listen(process.env.PORT, () => console.log(`Server running on port ${process.env.PORT}`));
});
