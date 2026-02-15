const express = require('express');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const puppeteer = require('puppeteer'); 
const ejs = require('ejs');
const fs = require('fs');

dotenv.config();
const app = express();

// --- 1. SESSION & MIDDLEWARE ---
app.use(session({
    secret: 'placement_portal_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

// --- 2. MULTER STORAGE (Resume Upload) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'), 
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// --- 3. DATABASE CONNECTION ---
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'placement_db'
});

// --- 4. AUTHENTICATION WALL ---
const requireLogin = (req, res, next) => {
    if (req.session.user) {
        next(); 
    } else {
        res.redirect('/login'); 
    }
};

// --- 5. AUTH & HOME ROUTES ---
app.get('/', requireLogin, async (req, res) => {
    try {
        const [scores] = await db.execute('SELECT * FROM mock_results WHERE user_id = ? ORDER BY test_date DESC', [req.session.user.id]);
        res.render('dashboard', { user: req.session.user, scores: scores });
    } catch (err) {
        res.render('dashboard', { user: req.session.user, scores: [] });
    }
});

app.get('/login', (req, res) => res.render('login', { error: null, msg: null }));
app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        await db.execute('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [username, email, password]);
        res.render('login', { msg: 'Account Created! Please Login.', error: null });
    } catch (err) { res.render('register', { error: 'Registration failed.' }); }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length > 0 && users[0].password === password) {
            req.session.user = users[0]; 
            res.redirect('/'); 
        } else {
            res.render('login', { error: 'Invalid Credentials', msg: null });
        }
    } catch (err) { res.render('login', { error: 'Login failed.', msg: null }); }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// --- 6. TOPIC SELECTION ROUTES (Including English) ---

// Aptitude
app.get('/aptitude-topics', requireLogin, async (req, res) => {
    try {
        const [topics] = await db.execute('SELECT DISTINCT topic FROM aptitude_questions WHERE category="Quantitative"');
        res.render('aptitude_topics', { topics, user: req.session.user });
    } catch (err) { res.redirect('/'); }
});

// Reasoning
app.get('/reasoning-topics', requireLogin, async (req, res) => {
    try {
        const [topics] = await db.execute('SELECT DISTINCT topic FROM aptitude_questions WHERE category="Logical"');
        res.render('reasoning_topics', { topics, user: req.session.user });
    } catch (err) { res.redirect('/'); }
});

// English (Verbal) - THIS WAS MISSING OR BROKEN BEFORE
app.get('/english-topics', requireLogin, async (req, res) => {
    try {
        const [topics] = await db.execute('SELECT DISTINCT topic FROM aptitude_questions WHERE category="Verbal"');
        res.render('english_topics', { topics, user: req.session.user });
    } catch (err) { res.redirect('/'); }
});

// Coding
app.get('/coding', requireLogin, async (req, res) => {
    try {
        const [topics] = await db.execute('SELECT DISTINCT topic FROM aptitude_questions WHERE category="Coding"');
        res.render('coding_topics', { topics, user: req.session.user, topicName: "Coding Hub" });
    } catch (err) { res.redirect('/'); }
});

// --- 🛠️ FIX FOR CODING HUB ERROR (Cannot POST /coding/practice) ---
app.post('/coding/practice', requireLogin, (req, res) => {
    const topicName = req.body.topic || req.body.subject; // Grab topic from form
    if (topicName) {
        // Redirect to the main practice route
        res.redirect(`/practice/${encodeURIComponent(topicName)}`);
    } else {
        res.redirect('/coding');
    }
});

// 🚀 DYNAMIC PRACTICE ROUTE (Limits to 15 Questions)
app.get('/practice/:topic', requireLogin, async (req, res) => {
    const topicName = decodeURIComponent(req.params.topic);
    try {
        const sql = `
            SELECT * FROM aptitude_questions 
            WHERE topic = ? 
            ORDER BY RAND() 
            LIMIT 15
        `;
        
        const [questions] = await db.execute(sql, [topicName]);

        if (questions.length === 0) {
            return res.send(`
                <div style="text-align:center; margin-top:50px;">
                    <h3>No questions found for topic: ${topicName}</h3>
                    <p>Please check if questions exist in database under this topic.</p>
                    <a href="/">Go Back</a>
                </div>
            `);
        }

        res.render('mocktest', { questions, user: req.session.user, topic: topicName });

    } catch (err) { 
        console.error(err);
        res.redirect('/'); 
    }
});

// Compatibility Redirects
app.get('/aptitude/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/reasoning/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/english/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/coding/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));


// --- 7. MOCK TEST & LEADERBOARD ---

// 🚀 FIXED: GLOBAL MOCK TEST (No Duplicates)
// app.js lo mocktest route ni ila marchu:
// MOCK TEST ROUTE
// Important: URL "/mocktest" ani undali (hyphen vaddu)
app.get('/mocktest', requireLogin, async (req, res) => {
    try {
        // 1. Random ga 30 questions select cheyadam
        // Note: Ikkada 'aptitude_questions' table nundi data testunnam
        const result = await db.query("SELECT * FROM aptitude_questions ORDER BY RAND() LIMIT 30");

        // 2. Mocktest page render cheyadam
        res.render('mocktest', { 
            questions: result[0],      // Questions pass chestunnam
            user: req.session.user     // Login ayina user details pass chestunnam
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error: Unable to load questions.");
    }
});

// Submit Route
app.post('/submit-quiz', requireLogin, async (req, res) => {
    const userAnswers = req.body;
    let score = 0;
    let reviewData = []; 

    try {
        for (const key in userAnswers) {
            if (key.startsWith('q')) {
                const qId = key.substring(1);
                const [qData] = await db.execute('SELECT * FROM aptitude_questions WHERE id = ?', [qId]);
                
                if (qData.length > 0) {
                    const question = qData[0];
                    const userAnswer = userAnswers[key];
                    const isCorrect = question.correct_option === userAnswer;
                    
                    if (isCorrect) score++;

                    reviewData.push({
                        question: question.question,
                        userAnswer: userAnswer,
                        correctAnswer: question.correct_option,
                        explanation: question.explanation || "No explanation available.",
                        isCorrect: isCorrect,
                        options: { A: question.option_a, B: question.option_b, C: question.option_c, D: question.option_d }
                    });
                }
            }
        }
        
        await db.execute('INSERT INTO mock_results (user_id, score, total) VALUES (?, ?, ?)', 
            [req.session.user.id, score, reviewData.length]);

        res.render('result', { 
            score, 
            total: reviewData.length, 
            reviewData, 
            user: req.session.user 
        });
    } catch (err) { 
        console.error(err);
        res.redirect('/'); 
    }
});

app.get('/leaderboard', requireLogin, async (req, res) => {
    try {
        const [rankings] = await db.execute(`
            SELECT u.username, MAX(m.score) as high_score, MAX(m.total) as total, MAX(m.test_date) as last_attempt
            FROM mock_results m JOIN users u ON m.user_id = u.id
            GROUP BY u.id, u.username ORDER BY high_score DESC LIMIT 10
        `);
        res.render('leaderboard', { rankings, user: req.session.user });
    } catch (err) { res.redirect('/'); }
});

// --- 8. RESUME BUILDER ROUTES ---

app.get('/interview-prep', requireLogin, (req, res) => {
    res.render('interview', { msg: null, user: req.session.user }); 
});

app.get('/resume-upload', requireLogin, async (req, res) => {
    try {
        const [history] = await db.execute('SELECT * FROM user_resumes WHERE email = ? ORDER BY created_at DESC', [req.session.user.email]);
        res.render('resume', { msg: null, user: req.session.user, history: history });
    } catch (err) {
        res.render('resume', { msg: null, user: req.session.user, history: [] });
    }
});

app.post('/upload-resume', requireLogin, upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) return res.redirect('/resume-upload');
        const sql = `INSERT INTO user_resumes (full_name, email, file_path, ats_score) VALUES (?, ?, ?, ?)`;
        await db.execute(sql, ['Uploaded: ' + req.file.originalname, req.session.user.email, req.file.path, 75]);
        res.redirect('/resume-upload');
    } catch (err) { res.redirect('/resume-upload'); }
});

app.post('/resume/generate', requireLogin, async (req, res) => {
    try {
        const d = req.body;
        const certs = Array.isArray(d['cert_list[]']) ? d['cert_list[]'].filter(c => c.trim() !== "").join(', ') : d['cert_list[]'];
        
        const projectsArray = [];
        if (Array.isArray(d['p_titles[]'])) {
            d['p_titles[]'].forEach((title, index) => {
                if (title.trim() !== "") projectsArray.push({ title: title, desc: d['p_descs[]'][index] });
            });
        }
        const projects_json = JSON.stringify(projectsArray);

        let score = 40;
        if (d.linkedin_link || d.github_link) score += 20;
        if (projectsArray.length > 0) score += 20;
        if (certs) score += 20;

        const sql = `INSERT INTO user_resumes (
            full_name, phone_number, persona_type, linkedin_link, github_link, 
            career_objective, projects_json, technical_skills, strengths, 
            languages_known, hobbies, certifications, high_qual_name, high_qual_college, 
            high_qual_loc, high_qual_score, inter_qual_name, inter_college, 
            inter_college_loc, inter_score, school_name_10th, school_10th_loc, 
            score_10th, ats_score, email, template_style
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

        const params = [
            d.full_name, d.phone_number, d.persona_type, d.linkedin_link, d.github_link,
            d.career_objective, projects_json, d.tech_skills, d.strengths,
            d.languages_known, d.hobbies, certs, d.high_qual_name, d.high_qual_college,
            d.high_qual_loc, d.high_qual_score, d.inter_qual_name, d.inter_college,
            d.inter_college_loc, d.inter_score, d.school_name_10th, d.school_10th_loc,
            d.score_10th, score, req.session.user.email, d.template_style
        ];

        await db.execute(sql, params);
        res.redirect('/resume-upload'); 
    } catch (err) { console.error(err); res.redirect('/resume-upload'); }
});

app.post('/resume/preview', requireLogin, async (req, res) => {
    let browser;
    try {
        const d = req.body;
        const certs = Array.isArray(d['cert_list[]']) ? d['cert_list[]'].filter(c => c.trim() !== "").join(', ') : d['cert_list[]'];
        const projectsArray = [];
        if (Array.isArray(d['p_titles[]'])) {
            d['p_titles[]'].forEach((title, index) => {
                if (title.trim() !== "") projectsArray.push({ title: title, desc: d['p_descs[]'][index] });
            });
        }
        const dataForTemplate = { ...d, email: req.session.user.email, projects: projectsArray, certifications: certs, ats_score: "PREVIEW" };
        const templateFile = d.template_style === 'modern' ? 'resume-modern.ejs' : 'resume-pdf.ejs';
        const html = await ejs.renderFile(path.join(__dirname, 'views', templateFile), { data: dataForTemplate });
        browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle2' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(Buffer.from(pdfBuffer, 'binary'));
    } catch (err) { if (browser) await browser.close(); res.status(500).send("Preview Error: " + err.message); }
});

app.get('/resume/download/:id', requireLogin, async (req, res) => {
    let browser;
    try {
        const [rows] = await db.execute('SELECT * FROM user_resumes WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).send("Resume Not Found");
        const r = rows[0];
        r.projects = JSON.parse(r.projects_json || '[]');
        const templateFile = r.template_style === 'modern' ? 'resume-modern.ejs' : 'resume-pdf.ejs';
        const html = await ejs.renderFile(path.join(__dirname, 'views', templateFile), { data: r });
        browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle2' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();
        res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${r.full_name.replace(/\s+/g, '_')}_Resume.pdf"`,
            'Content-Length': pdfBuffer.length
        });
        res.end(Buffer.from(pdfBuffer, 'binary'));
    } catch (err) { if (browser) await browser.close(); res.status(500).send("Error: " + err.message); }
});

app.get('/resume/delete/:id', requireLogin, async (req, res) => {
    try {
        await db.execute('DELETE FROM user_resumes WHERE id = ?', [req.params.id]);
        res.redirect('/resume-upload');
    } catch (err) { res.redirect('/resume-upload'); }
});

const startServer = (port) => {
    app.listen(port, () => {
        console.log(`🚀 Elite Placement Portal Live: http://localhost:${port}`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`⚠️ Port ${port} is busy, trying ${port + 1}...`);
            startServer(port + 1);
        } else { console.error(err); }
    });
};
// --- 🔥 ADD THIS LOADER TO YOUR BACKUP CODE ---
app.get('/load-all-quant', async (req, res) => {
    try {
        await db.query("DELETE FROM aptitude_questions WHERE category = 'Quantitative'");
        const addQ = async (topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            ['Quantitative', topic, q, a, b, c, d, corr, exp]);
        };

        // Sample Questions
        await addQ('Percentages', "What is 20% of 500?", "100", "200", "50", "150", "A", "500 * 0.20 = 100");
        await addQ('Trains', "100m train running at 36kmph crosses a pole in?", "10s", "12s", "15s", "8s", "A", "36kmph = 10m/s. 100/10 = 10s");
        // ఇక్కడ మనం ఇందాక అనుకున్న 15 క్వశ్చన్ల సెట్ ని యాడ్ చేసుకోవచ్చు.

        res.send("<h1>✅ SUCCESS: Data Loaded into Backup System!</h1><a href='/'>Go to Dashboard</a>");
    } catch(err) { res.send("Error: " + err.message); }
});
startServer(5000);