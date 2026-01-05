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
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'), 
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// --- 3. SMART DATABASE CONNECTION ---
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root', // ⚠️ Check your local password
    database: process.env.DB_NAME || 'placement_db',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false 
});

// --- AUTOMATIC TABLE CREATION (Local Only) ---
const setupDatabase = async () => {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS mock_results (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, score INT, total INT, topic VARCHAR(255), test_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Database tables checked/created!");
    } catch (err) {
        console.error("❌ Database Setup Error:", err);
    }
};
setupDatabase();


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
        console.error("Dashboard Error:", err);
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
    } catch (err) { 
        console.error("❌ Registration Error:", err); 
        res.render('register', { error: 'Registration failed. Email might already exist.' }); 
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        
        if (users.length > 0) {
            if (users[0].password === password) {
                req.session.user = users[0]; 
                res.redirect('/'); 
            } else {
                res.render('login', { error: 'Incorrect Password', msg: null });
            }
        } else {
            res.render('login', { error: 'User not found. Please Register.', msg: null });
        }
    } catch (err) { 
        console.error("❌ Login Error:", err); 
        res.render('login', { error: 'Login failed due to Server Error.', msg: null }); 
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// --- 6. TOPIC SELECTION ROUTES ---
app.get('/aptitude-topics', requireLogin, async (req, res) => {
    try {
        const [topics] = await db.execute('SELECT DISTINCT topic FROM aptitude_questions WHERE category="Quantitative"');
        res.render('aptitude_topics', { topics, user: req.session.user });
    } catch (err) { console.error(err); res.redirect('/'); }
});

app.get('/reasoning-topics', requireLogin, async (req, res) => {
    try {
        const [topics] = await db.execute('SELECT DISTINCT topic FROM aptitude_questions WHERE category="Logical"');
        res.render('reasoning_topics', { topics, user: req.session.user });
    } catch (err) { console.error(err); res.redirect('/'); }
});

app.get('/english-topics', requireLogin, async (req, res) => {
    try {
        const [topics] = await db.execute('SELECT DISTINCT topic FROM aptitude_questions WHERE category="Verbal"');
        res.render('english_topics', { topics, user: req.session.user });
    } catch (err) { console.error(err); res.redirect('/'); }
});

app.get('/coding', requireLogin, async (req, res) => {
    try {
        const [topics] = await db.execute('SELECT DISTINCT topic FROM aptitude_questions WHERE category="Coding"');
        res.render('coding_topics', { topics, user: req.session.user, topicName: "Coding Hub" });
    } catch (err) { console.error(err); res.redirect('/'); }
});

app.post('/coding/practice', requireLogin, (req, res) => {
    const topicName = req.body.topic || req.body.subject;
    if (topicName) {
        res.redirect(`/practice/${encodeURIComponent(topicName)}`);
    } else {
        res.redirect('/coding');
    }
});

app.get('/practice/:topic', requireLogin, async (req, res) => {
    const topicName = decodeURIComponent(req.params.topic);
    try {
        const sql = `SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 15`;
        const [questions] = await db.execute(sql, [topicName]);

        if (questions.length === 0) {
            return res.send(`
                <div style="text-align:center; margin-top:50px;">
                    <h3>No questions found for topic: ${topicName}</h3>
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

app.get('/aptitude/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/reasoning/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/english/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/coding/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));

// --- 7. MOCK TEST & LEADERBOARD ---
app.get('/mock-test', requireLogin, async (req, res) => {
    try {
        const [result] = await db.query("SELECT * FROM aptitude_questions ORDER BY RAND() LIMIT 30");
        res.render('mocktest', { questions: result, user: req.session.user, topic: "Full Mock Test" });
    } catch (err) {
        console.error("Mocktest Load Error:", err);
        res.status(500).send("Server Error: Unable to load questions.");
    }
});

app.post('/submit-quiz', requireLogin, async (req, res) => {
    const userAnswers = req.body;
    const topicName = req.body.topic_name || "General Test"; 
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
        await db.execute('INSERT INTO mock_results (user_id, score, total, topic) VALUES (?, ?, ?, ?)', 
            [req.session.user.id, score, reviewData.length, topicName]);
        res.render('result', { score, total: reviewData.length, reviewData, user: req.session.user });
    } catch (err) { console.error("Submit Error:", err); res.redirect('/'); }
});

app.get('/leaderboard', requireLogin, async (req, res) => {
    try {
        const [rankings] = await db.execute(`
            SELECT u.username, MAX(m.score) as high_score, MAX(m.total) as total, MAX(m.test_date) as last_attempt
            FROM mock_results m JOIN users u ON m.user_id = u.id
            GROUP BY u.id, u.username ORDER BY high_score DESC LIMIT 10
        `);
        const [myScores] = await db.execute('SELECT * FROM mock_results WHERE user_id = ? ORDER BY test_date DESC LIMIT 20', [req.session.user.id]);
        res.render('leaderboard', { rankings, myScores, user: req.session.user });
    } catch (err) { console.error(err); res.redirect('/'); }
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
        console.error(err);
        res.render('resume', { msg: null, user: req.session.user, history: [] });
    }
});

app.post('/upload-resume', requireLogin, upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) return res.redirect('/resume-upload');
        const sql = `INSERT INTO user_resumes (full_name, email, file_path, ats_score) VALUES (?, ?, ?, ?)`;
        await db.execute(sql, ['Uploaded: ' + req.file.originalname, req.session.user.email, req.file.path, 75]);
        res.redirect('/resume-upload');
    } catch (err) { console.error(err); res.redirect('/resume-upload'); }
});

app.post('/resume/generate', requireLogin, async (req, res) => {
    try {
        const d = req.body;
        const certs = Array.isArray(d['cert_list[]']) ? d['cert_list[]'].filter(c => c && c.trim() !== "").join(', ') : (d['cert_list[]'] || "");
        const projectsArray = [];
        const titles = d['p_titles[]'];
        const descs = d['p_descs[]'];

        if (Array.isArray(titles)) {
            titles.forEach((title, index) => {
                if (title && title.trim() !== "") {
                    projectsArray.push({ title: title, desc: (Array.isArray(descs) ? descs[index] : "") });
                }
            });
        } else if (titles) {
             projectsArray.push({ title: titles, desc: descs || "" });
        }
        const projects_json = JSON.stringify(projectsArray);
        let score = 40;
        if (d.linkedin_link || d.github_link) score += 20;
        if (projectsArray.length > 0) score += 20;
        if (certs) score += 20;

        const sql = `INSERT INTO user_resumes (full_name, phone_number, persona_type, linkedin_link, github_link, career_objective, projects_json, technical_skills, strengths, languages_known, hobbies, certifications, high_qual_name, high_qual_college, high_qual_loc, high_qual_score, inter_qual_name, inter_college, inter_college_loc, inter_score, school_name_10th, school_10th_loc, score_10th, ats_score, email, template_style) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
        const params = [d.full_name, d.phone_number, d.persona_type, d.linkedin_link, d.github_link, d.career_objective, projects_json, d.tech_skills, d.strengths, d.languages_known, d.hobbies, certs, d.high_qual_name, d.high_qual_college, d.high_qual_loc, d.high_qual_score, d.inter_qual_name, d.inter_college, d.inter_college_loc, d.inter_score, d.school_name_10th, d.school_10th_loc, d.score_10th, score, req.session.user.email, d.template_style];

        await db.execute(sql, params);
        res.redirect('/resume-upload'); 
    } catch (err) { console.error("Resume Gen Error:", err); res.redirect('/resume-upload'); }
});

app.post('/resume/preview', requireLogin, async (req, res) => {
    let browser;
    try {
        const d = req.body;
        const certs = Array.isArray(d['cert_list[]']) ? d['cert_list[]'].filter(c => c.trim() !== "").join(', ') : (d['cert_list[]'] || "");
        const projectsArray = [];
        const titles = d['p_titles[]'];
        const descs = d['p_descs[]'];

        if (Array.isArray(titles)) {
            titles.forEach((title, index) => {
                if (title && title.trim() !== "") projectsArray.push({ title: title, desc: (Array.isArray(descs) ? descs[index] : "") });
            });
        } else if (titles) {
            projectsArray.push({ title: titles, desc: descs || "" });
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
    } catch (err) { 
        if (browser) await browser.close(); 
        console.error("Preview Error:", err);
        res.status(500).send("Preview Error: " + err.message); 
    }
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
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${r.full_name.replace(/\s+/g, '_')}_Resume.pdf"`, 'Content-Length': pdfBuffer.length });
        res.end(Buffer.from(pdfBuffer, 'binary'));
    } catch (err) { 
        if (browser) await browser.close(); 
        console.error("Download Error:", err);
        res.status(500).send("Error: " + err.message); 
    }
});

app.get('/resume/delete/:id', requireLogin, async (req, res) => {
    try {
        await db.execute('DELETE FROM user_resumes WHERE id = ?', [req.params.id]);
        res.redirect('/resume-upload');
    } catch (err) { console.error(err); res.redirect('/resume-upload'); }
});

// 🔥🔥🔥 MAGIC SETUP ROUTE (ADD THIS to create Cloud Tables) 🔥🔥🔥
app.get('/magic-setup', async (req, res) => {
    try {
        // This will attempt to create ALL tables using the current DB connection (Cloud or Local)
        const queries = [
            `CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
            `CREATE TABLE IF NOT EXISTS mock_results (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, score INT, total INT, topic VARCHAR(255), test_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
            `CREATE TABLE IF NOT EXISTS user_resumes (id INT AUTO_INCREMENT PRIMARY KEY, full_name VARCHAR(255), email VARCHAR(255), phone_number VARCHAR(50), persona_type VARCHAR(50), linkedin_link TEXT, github_link TEXT, career_objective TEXT, projects_json JSON, technical_skills TEXT, strengths TEXT, languages_known TEXT, hobbies TEXT, certifications TEXT, high_qual_name VARCHAR(255), high_qual_college VARCHAR(255), high_qual_loc VARCHAR(255), high_qual_score VARCHAR(50), inter_qual_name VARCHAR(255), inter_college VARCHAR(255), inter_college_loc VARCHAR(255), inter_score VARCHAR(50), school_name_10th VARCHAR(255), school_10th_loc VARCHAR(255), score_10th VARCHAR(50), ats_score INT DEFAULT 0, template_style VARCHAR(50) DEFAULT 'modern', file_path TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
            `CREATE TABLE IF NOT EXISTS aptitude_questions (id INT AUTO_INCREMENT PRIMARY KEY, category VARCHAR(50), topic VARCHAR(100), question TEXT NOT NULL, option_a VARCHAR(255) NOT NULL, option_b VARCHAR(255) NOT NULL, option_c VARCHAR(255) NOT NULL, option_d VARCHAR(255) NOT NULL, correct_option CHAR(1) NOT NULL, explanation TEXT)`
        ];

        for (const query of queries) {
            await db.execute(query);
        }
        res.send("<h1>✅ SUCCESS! Tables Created Successfully!</h1><p>You can now go back and Register.</p>");
    } catch (err) {
        res.send(`<h1>❌ Error: ${err.message}</h1><p>Check your Render Environment Variables.</p>`);
    }
});


// --- SERVER START LOGIC ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log("\n==================================================");
    console.log(`🚀  SERVER STARTED SUCCESSFULLY!`);
    console.log(`👉  Open your browser and go to: http://localhost:${PORT}`);
    console.log("==================================================\n");
});