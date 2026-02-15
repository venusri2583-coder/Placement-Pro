const express = require('express');
const app = express();
const path = require('path');
const session = require('express-session');

// 🔥 NOTE: NO DATABASE CONNECTION to prevent Error 520 Crashes
// This uses local memory. Perfect for Demos/Presentations.

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'demo_key',
    resave: false,
    saveUninitialized: false
}));

// --- FAKE DATA FOR DEMO ---
const LEADERBOARD_DATA = [
    { username: 'Rahul (You)', high_score: 28 },
    { username: 'Priya', high_score: 29 },
    { username: 'Sandeep', high_score: 27 },
    { username: 'Sneha', high_score: 25 },
    { username: 'Ravi', high_score: 22 }
];

const RESUME_DATA = [
    { full_name: 'Rahul Kumar', created_at: new Date() }
];

// --- ROUTES ---

// 1. LOGIN (Auto-Login for Demo)
app.get('/login', (req, res) => res.render('login', { error: null, msg: null }));
app.post('/login', (req, res) => {
    req.session.user = { id: 1, username: 'Rahul', email: req.body.email };
    res.redirect('/');
});
app.get('/register', (req, res) => res.render('register', { error: null, msg: null }));
app.post('/register', (req, res) => res.render('login', { msg: 'Account Created', error: null }));
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// 2. DASHBOARD
app.get('/', (req, res) => {
    if(!req.session.user) return res.redirect('/login');
    // Fake scores history
    const scores = [
        { topic: 'Percentages', score: 8, total: 10, test_date: new Date() },
        { topic: 'Java', score: 9, total: 10, test_date: new Date() }
    ];
    res.render('dashboard', { user: req.session.user, scores });
});

// 3. MENUS (All working)
app.get('/aptitude-topics', (req, res) => { if(!req.session.user) return res.redirect('/login'); res.render('aptitude_topics', { user: req.session.user }); });
app.get('/reasoning-topics', (req, res) => { if(!req.session.user) return res.redirect('/login'); res.render('reasoning_topics', { user: req.session.user }); });
app.get('/english-topics', (req, res) => { if(!req.session.user) return res.redirect('/login'); res.render('english_topics', { user: req.session.user }); });
app.get('/coding', (req, res) => { if(!req.session.user) return res.redirect('/login'); res.render('coding_topics', { user: req.session.user }); });

// 4. MISSING PAGES (Restored with Static Data)
app.get('/leaderboard', (req, res) => {
    if(!req.session.user) return res.redirect('/login');
    res.render('leaderboard', { user: req.session.user, rankings: LEADERBOARD_DATA, myScores: [] });
});

app.get('/interview-prep', (req, res) => {
    if(!req.session.user) return res.redirect('/login');
    res.render('interview', { user: req.session.user, msg: null });
});

app.get('/resume-upload', (req, res) => {
    if(!req.session.user) return res.redirect('/login');
    res.render('resume', { user: req.session.user, msg: null, history: RESUME_DATA });
});
app.post('/upload-resume', (req, res) => res.redirect('/resume-upload'));

// 5. REDIRECTS
app.get('/aptitude/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/reasoning/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/english/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/coding/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/mock-test', (req, res) => res.redirect('/practice/MockTest'));

// 6. PRACTICE ENGINE (Auto-Generates Questions for ANY Topic)
app.get('/practice/:topic', (req, res) => {
    if(!req.session.user) return res.redirect('/login');
    const topic = req.params.topic;
    
    // Generate 30 dummy questions instantly
    let questions = [];
    for(let i=1; i<=30; i++) {
        let qText = `[${topic}] Question ${i}: Identify the correct answer based on ${topic} concepts.`;
        let optA = "Correct Answer";
        
        // Make numbers real for Maths
        if(['Percentages', 'Profit', 'Averages', 'Time'].some(x => topic.includes(x))) {
            let n1 = 100 + i;
            qText = `Calculate ${i}% of ${n1}.`;
            optA = `${(n1 * i / 100).toFixed(2)}`;
        }

        questions.push({
            id: i,
            question: qText,
            option_a: optA,
            option_b: "Wrong Option 1",
            option_c: "Wrong Option 2",
            option_d: "Wrong Option 3",
            correct_option: "A",
            explanation: "This is the correct answer logic."
        });
    }

    res.render('mocktest', { questions, user: req.session.user, topic });
});

app.post('/submit-quiz', (req, res) => {
    // Fake Result
    res.render('result', { score: 25, total: 30, reviewData: [], user: req.session.user });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Presentation Server running on ${PORT}`));