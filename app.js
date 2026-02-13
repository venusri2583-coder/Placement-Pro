const express = require('express');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const ejs = require('ejs');
const fs = require('fs');

// 🔥 STEP 1: Session Store Import (Must be at the top)
const MySQLStore = require('express-mysql-session')(session);

dotenv.config();
const app = express();

// 🔥 STEP 2: Database Connection (Must connect first)
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'placement_db',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false 
});

// 🔥 STEP 3: Session Configuration (Must be after DB)
const sessionStore = new MySQLStore({}, db); 

app.use(session({
    key: 'placement_portal_session',
    secret: 'placement_portal_secret',
    store: sessionStore,  // Stores sessions in DB (Fixes Memory Leak Warning)
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 Day
}));

// --- Standard Middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

// --- Multer Setup (For Resume Uploads) ---
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'), 
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// --- Auth Middleware ---
const requireLogin = (req, res, next) => {
    if (req.session.user) { next(); } else { res.redirect('/login'); }
};

// ================= ROUTES START HERE =================

// 1. Dashboard & Auth
app.get('/', requireLogin, async (req, res) => {
    try {
        const [scores] = await db.execute('SELECT * FROM mock_results WHERE user_id = ? ORDER BY test_date DESC', [req.session.user.id]);
        res.render('dashboard', { user: req.session.user, scores: scores });
    } catch (err) { res.render('dashboard', { user: req.session.user, scores: [] }); }
});

app.get('/login', (req, res) => res.render('login', { error: null, msg: null }));
app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        await db.execute('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [username, email, password]);
        res.render('login', { msg: 'Account Created!', error: null });
    } catch (err) { res.render('register', { error: 'Email exists.' }); }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length > 0 && users[0].password === password) {
            req.session.user = users[0]; 
            res.redirect('/'); 
        } else { res.render('login', { error: 'Wrong Password', msg: null }); }
    } catch (err) { res.render('login', { error: 'Server Error', msg: null }); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// 2. Topic Routes
app.get('/aptitude-topics', requireLogin, async (req, res) => {
    try {
        const [topics] = await db.execute("SELECT DISTINCT topic FROM aptitude_questions WHERE category='Quantitative'");
        res.render('aptitude_topics', { topics, user: req.session.user });
    } catch (err) { res.send(err.message); }
});

app.get('/reasoning-topics', requireLogin, async (req, res) => {
    try {
        const [topics] = await db.execute("SELECT DISTINCT topic FROM aptitude_questions WHERE category='Logical'");
        res.render('reasoning_topics', { topics, user: req.session.user });
    } catch (err) { res.redirect('/'); }
});

app.get('/english-topics', requireLogin, async (req, res) => {
    try {
        const [topics] = await db.execute("SELECT DISTINCT topic FROM aptitude_questions WHERE category='Verbal'");
        res.render('english_topics', { topics, user: req.session.user });
    } catch (err) { res.redirect('/'); }
});

app.get('/coding', requireLogin, async (req, res) => {
    try {
        res.render('coding_topics', { user: req.session.user });
    } catch (err) { res.redirect('/'); }
});

// 3. Practice Engine
app.post('/coding/practice', requireLogin, (req, res) => {
    const topicName = req.body.topic;
    if (topicName) res.redirect(`/practice/${encodeURIComponent(topicName)}`);
    else res.redirect('/coding');
});

app.get('/practice/:topic', requireLogin, async (req, res) => {
    const topicName = decodeURIComponent(req.params.topic);
    const userId = req.session.user.id;

    try {
        const [done] = await db.execute('SELECT question_id FROM user_progress WHERE user_id = ?', [userId]);
        const doneIds = done.map(row => row.question_id);
        
        let query, params;
        if (doneIds.length > 0) {
            const placeholders = doneIds.map(() => '?').join(',');
            query = `SELECT * FROM aptitude_questions WHERE topic = ? AND id NOT IN (${placeholders}) ORDER BY RAND() LIMIT 30`;
            params = [topicName, ...doneIds];
        } else {
            query = `SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 30`;
            params = [topicName];
        }

        const [questions] = await db.execute(query, params);

        if (questions.length === 0) {
            const [total] = await db.execute('SELECT COUNT(*) as count FROM aptitude_questions WHERE topic = ?', [topicName]);
            if(total[0].count === 0) {
                 return res.send(`<div style="text-align:center; padding:50px;"><h2>No questions found for: ${topicName}</h2><p>Please run <a href="/final-fix-v3">/final-fix-v3</a> to load data.</p></div>`);
            } else {
                 return res.send(`
                    <div style="text-align:center; padding:50px; font-family:sans-serif;">
                        <h2>🎉 You have completed all questions in ${topicName}!</h2>
                        <form action="/reset-progress" method="POST">
                            <input type="hidden" name="topic" value="${topicName}">
                            <button style="padding:10px 20px; background:blue; color:white; border:none; cursor:pointer;">Reset & Start Over</button>
                        </form>
                        <br><a href="/">Go Home</a>
                    </div>
                 `);
            }
        }
        res.render('mocktest', { questions, user: req.session.user, topic: topicName });
    } catch (err) { res.redirect('/'); }
});

app.post('/reset-progress', requireLogin, async (req, res) => {
    const { topic } = req.body;
    await db.execute('DELETE FROM user_progress WHERE user_id = ? AND topic = ?', [req.session.user.id, topic]);
    res.redirect(`/practice/${encodeURIComponent(topic)}`);
});

// Shortcuts for 3D Cards
app.get('/aptitude/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/english/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/reasoning/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));
app.get('/coding/:topic', (req, res) => res.redirect(`/practice/${req.params.topic}`));

// 4. Mock Test
app.get('/mock-test', requireLogin, async (req, res) => {
    try {
        const [result] = await db.query("SELECT * FROM aptitude_questions ORDER BY RAND() LIMIT 30");
        res.render('mocktest', { questions: result, user: req.session.user, topic: "Full Mock Test" });
    } catch(err) { res.redirect('/'); }
});

app.post('/submit-quiz', requireLogin, async (req, res) => {
    const userAnswers = req.body;
    let score = 0, total = 0;
    let reviewData = [];

    for (const key in userAnswers) {
        if (key.startsWith('q')) {
            const qId = key.substring(1);
            const [q] = await db.execute('SELECT * FROM aptitude_questions WHERE id=?', [qId]);
            if(q.length > 0) {
                const question = q[0];
                const isCorrect = question.correct_option === userAnswers[key];
                if(isCorrect) score++;
                total++;
                await db.execute('INSERT IGNORE INTO user_progress (user_id, question_id, topic) VALUES (?, ?, ?)', [req.session.user.id, qId, question.topic]);
                reviewData.push({ q: question.question, userAns: userAnswers[key], correctAns: question.correct_option, explanation: question.explanation, isCorrect: isCorrect });
            }
        }
    }
    await db.execute('INSERT INTO mock_results (user_id, score, total, topic) VALUES (?, ?, ?, ?)', [req.session.user.id, score, total, req.body.topic_name || "Quiz"]);
    res.render('result', { score, total, reviewData, user: req.session.user });
});

app.get('/leaderboard', requireLogin, async (req, res) => {
    try {
        const [rankings] = await db.execute(`SELECT u.username, MAX(m.score) as high_score FROM mock_results m JOIN users u ON m.user_id = u.id GROUP BY u.id, u.username ORDER BY high_score DESC LIMIT 10`);
        const [myScores] = await db.execute('SELECT * FROM mock_results WHERE user_id = ? ORDER BY test_date DESC LIMIT 10', [req.session.user.id]);
        res.render('leaderboard', { rankings, myScores, user: req.session.user });
    } catch (err) { res.redirect('/'); }
});

// 5. Resume & Interview
app.get('/interview-prep', requireLogin, (req, res) => res.render('interview', { msg: null, user: req.session.user }));
app.get('/resume-upload', requireLogin, async (req, res) => {
    try {
        const [history] = await db.execute('SELECT * FROM user_resumes WHERE email = ? ORDER BY created_at DESC', [req.session.user.email]);
        res.render('resume', { msg: null, user: req.session.user, history: history });
    } catch (err) { res.render('resume', { msg: null, user: req.session.user, history: [] }); }
});
app.post('/upload-resume', requireLogin, upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) return res.redirect('/resume-upload');
        await db.execute(`INSERT INTO user_resumes (full_name, email, file_path, ats_score) VALUES (?, ?, ?, ?)`, ['Uploaded Resume', req.session.user.email, req.file.path, 75]);
        res.redirect('/resume-upload');
    } catch (err) { res.redirect('/resume-upload'); }
});
app.post('/resume/generate', requireLogin, async (req, res) => {
    try {
        const d = req.body;
        const projectsArray = [];
        const titles = d['p_titles[]'];
        const descs = d['p_descs[]'];
        if (Array.isArray(titles)) {
            titles.forEach((title, index) => { if (title && title.trim() !== "") projectsArray.push({ title: title, desc: (Array.isArray(descs) ? descs[index] : "") }); });
        } else if (titles) { projectsArray.push({ title: titles, desc: descs || "" }); }
        const sql = `INSERT INTO user_resumes (full_name, phone_number, persona_type, linkedin_link, github_link, career_objective, projects_json, technical_skills, strengths, languages_known, hobbies, certifications, high_qual_name, high_qual_college, high_qual_loc, high_qual_score, inter_qual_name, inter_college, inter_college_loc, inter_score, school_name_10th, school_10th_loc, score_10th, ats_score, email, template_style) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
        const params = [d.full_name, d.phone_number, d.persona_type, d.linkedin_link, d.github_link, d.career_objective, JSON.stringify(projectsArray), d.tech_skills, d.strengths, d.languages_known, d.hobbies, d.certifications, d.high_qual_name, d.high_qual_college, d.high_qual_loc, d.high_qual_score, d.inter_qual_name, d.inter_college, d.inter_college_loc, d.inter_score, d.school_name_10th, d.school_10th_loc, d.score_10th, 85, req.session.user.email, d.template_style];
        await db.execute(sql, params);
        res.redirect('/resume-upload'); 
    } catch (err) { console.error(err); res.redirect('/resume-upload'); }
});
app.get('/resume/delete/:id', requireLogin, async (req, res) => {
    await db.execute('DELETE FROM user_resumes WHERE id = ?', [req.params.id]);
    res.redirect('/resume-upload');
});

// A. MAGIC SETUP (Creates Tables)
app.get('/magic-setup', async (req, res) => {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(255), email VARCHAR(255), password VARCHAR(255))`);
        await db.execute(`CREATE TABLE IF NOT EXISTS aptitude_questions (id INT AUTO_INCREMENT PRIMARY KEY, category VARCHAR(50), topic VARCHAR(100), question TEXT, option_a VARCHAR(255), option_b VARCHAR(255), option_c VARCHAR(255), option_d VARCHAR(255), correct_option VARCHAR(10), explanation TEXT)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS mock_results (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, score INT, total INT, topic VARCHAR(255), test_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS user_resumes (id INT AUTO_INCREMENT PRIMARY KEY, full_name VARCHAR(255), email VARCHAR(255), phone_number VARCHAR(50), persona_type VARCHAR(50), linkedin_link TEXT, github_link TEXT, career_objective TEXT, projects_json JSON, technical_skills TEXT, strengths TEXT, languages_known TEXT, hobbies TEXT, certifications TEXT, high_qual_name VARCHAR(255), high_qual_college VARCHAR(255), high_qual_loc VARCHAR(255), high_qual_score VARCHAR(50), inter_qual_name VARCHAR(255), inter_college VARCHAR(255), inter_college_loc VARCHAR(255), inter_score VARCHAR(50), school_name_10th VARCHAR(255), school_10th_loc VARCHAR(255), score_10th VARCHAR(50), ats_score INT DEFAULT 0, template_style VARCHAR(50) DEFAULT 'modern', file_path TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS user_progress (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT, question_id INT, topic VARCHAR(255), UNIQUE KEY unique_attempt (user_id, question_id))`);
        res.send("<h1>✅ Tables Created!</h1>");
    } catch (err) { res.send(err.message); }
});

// B. FINAL DATA FIX V3 (Combines ALL Data: Quant + Reasoning + Verbal + Coding)
app.get('/final-fix-v3', async (req, res) => {
    try {
        // 1. Delete old data to prevent duplicates
        await db.query(`DELETE FROM aptitude_questions`);

        // 2. Insert ALL Questions
        const sql = `INSERT INTO aptitude_questions (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) VALUES 
        
        -- ⏳ TIME AND WORK
        ('Quantitative', 'Time and Work', 'A in 15 days, B in 20 days. Together 4 days. Work left?', '8/15', '7/15', '1/4', '1/10', 'A', 'Work done 4*(1/15+1/20)=7/15. Left 8/15'),
        ('Quantitative', 'Time and Work', 'A is thrice good as B. 60 days less. Together?', '22.5 days', '20 days', '25 days', '30 days', 'A', 'Diff 2u=60. A=30, B=90. Together 22.5'),
        ('Quantitative', 'Time and Work', 'A does 80% in 20 days. A+B finish rem in 3 days. B alone?', '37.5 days', '40 days', '35 days', '45 days', 'A', 'A total 25. Rem 20% in 3 days. Calc B'),
        ('Quantitative', 'Time and Work', '12 men in 18 days. After 6 days, 4 join. Rem work?', '9 days', '10 days', '12 days', '8 days', 'A', '12*12 units left. 16 men. 144/16=9'),
        ('Quantitative', 'Time and Work', 'A+B 12, B+C 15, C+A 20. Together?', '10 days', '5 days', '15 days', '20 days', 'A', '2(A+B+C)=1/5. A+B+C=1/10'),
        ('Quantitative', 'Time and Work', 'A 10 days, B 15 days. Together?', '6 days', '5 days', '8 days', '7 days', 'A', '10*15/25 = 6'),
        ('Quantitative', 'Time and Work', '10 men in 10 days. 5 men?', '20 days', '10 days', '5 days', '15 days', 'A', 'Inverse prop'),
        ('Quantitative', 'Time and Work', 'A 6 days, B 9 days. Combined?', '3.6 days', '4 days', '3 days', '5 days', 'A', '54/15'),
        ('Quantitative', 'Time and Work', 'A+B 12 days. B alone 30. A alone?', '20 days', '15 days', '25 days', '10 days', 'A', '1/12 - 1/30 = 1/20'),
        ('Quantitative', 'Time and Work', 'A,B,C in 24, 6, 12. Together?', '3 3/7 days', '3 days', '4 days', '5 days', 'A', 'LCM 24. 1+4+2=7. 24/7'),
        ('Quantitative', 'Time and Work', 'A 50% more efficient than B. B 12 days. A?', '8 days', '6 days', '10 days', '9 days', 'A', 'Ratio 3:2 eff. Time 2:3'),
        ('Quantitative', 'Time and Work', '4M 6W in 8 days. 3M 7W in 10 days. 10W?', '40 days', '35 days', '50 days', '45 days', 'A', 'Solve eq'),
        ('Quantitative', 'Time and Work', 'A twice fast as B. Together 8 days. B alone?', '24 days', '16 days', '32 days', '12 days', 'A', 'Total 3*8=24 units'),
        ('Quantitative', 'Time and Work', '15 men in 20 days. 10 men?', '30 days', '40 days', '25 days', '35 days', 'A', '300/10'),
        ('Quantitative', 'Time and Work', 'Pipe fill 10hr, leak empty 20hr. Full?', '20 hr', '15 hr', '30 hr', '25 hr', 'A', '1/10-1/20'),
        ('Quantitative', 'Time and Work', 'Pipes 20min, 30min. Together?', '12 min', '10 min', '15 min', '25 min', 'A', '600/50'),
        ('Quantitative', 'Time and Work', 'A+B 550. A+B 7/11. C gets?', '200', '150', '300', '250', 'A', 'C does 4/11'),
        ('Quantitative', 'Time and Work', 'A 8hr, B 10hr. Together?', '4.44 hr', '5 hr', '4 hr', '6 hr', 'A', '80/18'),
        ('Quantitative', 'Time and Work', '10M 6H 18D. 15M 12D Hours?', '6', '5', '4', '8', 'A', 'M1D1H1'),
        ('Quantitative', 'Time and Work', 'A 30% more eff B. A 23 days. Together?', '13 days', '12 days', '15 days', '20 days', 'A', '130:100. Total 23*13. Together 23'),
        ('Quantitative', 'Time and Work', 'A 18 days, B 15 days. B worked 10. A rem?', '6 days', '5 days', '8 days', '7 days', 'A', 'Rem 1/3'),
        ('Quantitative', 'Time and Work', 'A 4hr, B 6hr. Alt hrs start A. Time?', '4hr 40min', '5hr', '4.5hr', '6hr', 'A', 'Cycle'),
        ('Quantitative', 'Time and Work', 'Eff A twice B. A 30 days less. Together?', '20 days', '25 days', '30 days', '15 days', 'A', 'A=30, B=60'),
        ('Quantitative', 'Time and Work', 'A 12, B 24. A leaves 2 days before. Total?', '10 days', '8 days', '9 days', '12 days', 'A', 'Work done'),
        ('Quantitative', 'Time and Work', 'P 1/4 10d, Q 40% 40d, R 1/3 13d. Fastest?', 'R', 'P', 'Q', 'S', 'A', 'R is fastest'),
        ('Quantitative', 'Time and Work', 'P 8hr, Q 10hr, R 12hr. P closed 11am (start 9). Finish?', '1 pm', '12 pm', '2 pm', '3 pm', 'A', 'Work rate'),
        ('Quantitative', 'Time and Work', 'A half work of B in 3/4 time. Together 18. B?', '30 days', '40 days', '35 days', '45 days', 'A', 'Ratio'),
        ('Quantitative', 'Time and Work', 'A 80 days. 10 days done. B finish 42. Together?', '30 days', '25 days', '40 days', '50 days', 'A', 'Calc'),
        ('Quantitative', 'Time and Work', '4M 5W 15d. 9M 6W 10d. 1 man?', '140 days', '100 days', '120 days', '80 days', 'A', 'Eq'),
        ('Quantitative', 'Time and Work', 'Work by x-1 men in x+1 days...?', '8', '10', '12', '6', 'A', 'Ratio 9:10'),

        -- 🚂 TRAINS
        ('Quantitative', 'Problems on Trains', 'Train 100m passes pole 10s. Speed?', '36 kmph', '40 kmph', '30 kmph', '50 kmph', 'A', '10m/s'),
        ('Quantitative', 'Problems on Trains', 'Train 240m pole 24s. Platform 650m?', '89s', '100s', '90s', '80s', 'A', '890/10'),
        ('Quantitative', 'Problems on Trains', '140m and 160m opp dir 60, 40 kmph. Time?', '10.8s', '11s', '12s', '10s', 'A', '300/27.7'),
        ('Quantitative', 'Problems on Trains', 'Cross man 5s, platform 100m 15s. Len?', '50m', '60m', '75m', '100m', 'A', '50'),
        ('Quantitative', 'Problems on Trains', '110m 60kmph cross man 6kmph opp. Time?', '6s', '5s', '7s', '8s', 'A', '110/18.3'),
        ('Quantitative', 'Problems on Trains', '125m cross man 5kmph same 10s. Speed?', '50 kmph', '45 kmph', '55 kmph', '60 kmph', 'A', 'Rel 45'),
        ('Quantitative', 'Problems on Trains', 'Bridges 800m 400m in 100s 60s. Len?', '200m', '150m', '250m', '300m', 'A', '200'),
        ('Quantitative', 'Problems on Trains', '108 kmph in m/s?', '30', '20', '25', '35', 'A', '30'),
        ('Quantitative', 'Problems on Trains', '150m cross 450m in 20s. Speed?', '30 m/s', '25 m/s', '20 m/s', '35 m/s', 'A', '600/20'),
        ('Quantitative', 'Problems on Trains', 'Speed ratio 7:8. 2nd 400km 4hr. 1st?', '87.5', '80', '90', '85', 'A', 'S2=100'),
        ('Quantitative', 'Problems on Trains', '280m 63kmph cross tree?', '16s', '15s', '18s', '20s', 'A', '280/17.5'),
        ('Quantitative', 'Problems on Trains', 'Stops: 50kmph vs 40kmph. Min?', '12 min', '10 min', '15 min', '20 min', 'A', '10/50*60'),
        ('Quantitative', 'Problems on Trains', 'Speeds 2:3:4. Time?', '6:4:3', '4:3:2', '3:4:6', '2:3:4', 'A', 'Inverse'),
        ('Quantitative', 'Problems on Trains', '7/11 speed reach 22hr. Saved?', '8 hr', '10 hr', '12 hr', '14 hr', 'A', '22-14'),
        ('Quantitative', 'Problems on Trains', 'Jogger 9kmph Engine 45kmph 240m. Time?', '24s', '30s', '36s', '40s', 'A', '240/10'),
        ('Quantitative', 'Problems on Trains', 'Equal len 10s 15s opp. Cross?', '12s', '13s', '12.5s', '14s', 'A', '2*10*15/25'),
        ('Quantitative', 'Problems on Trains', '360m 45kmph cross bridge 140m?', '40s', '45s', '35s', '30s', 'A', '500/12.5'),
        ('Quantitative', 'Problems on Trains', 'A met B 4h48m 3h20m. Speed ratio?', '2:3', '3:2', '4:5', '5:4', 'B', 'Sqrt'),
        ('Quantitative', 'Problems on Trains', '150m bridge 500m 30s. Plat 370m?', '24s', '25s', '20s', '22s', 'A', 'Speed calc'),
        ('Quantitative', 'Problems on Trains', 'Cross man 27s 17s. Each other 23s. Ratio?', '3:2', '2:3', '4:3', '3:4', 'A', 'Alligation'),
        ('Quantitative', 'Problems on Trains', 'A 120m B 180m opp 50,40. Time?', '12s', '10s', '15s', '14s', 'A', '300/25'),
        ('Quantitative', 'Problems on Trains', '100m 30kmph bridge time?', 'Depends', '10s', 'Data inq', 'None', 'C', 'Need bridge len'),
        ('Quantitative', 'Problems on Trains', '125m man 5kmph same 10s. Speed?', '50 kmph', '45 kmph', '55 kmph', '60 kmph', 'A', '50'),
        ('Quantitative', 'Problems on Trains', 'Relative speed opp?', 'S1+S2', 'S1-S2', 'S1*S2', 'S1/S2', 'A', 'Add'),
        ('Quantitative', 'Problems on Trains', 'Platform 36s Man 20s Speed 54. Plat?', '240m', '200m', '300m', '250m', 'A', '240'),
        ('Quantitative', 'Problems on Trains', '90kmph cross pole time?', 'Depends', '10s', 'Data inq', 'None', 'C', 'Need len'),
        ('Quantitative', 'Problems on Trains', '800m 72kmph tunnel 200m?', '50s', '40s', '60s', '55s', 'A', '1000/20'),
        ('Quantitative', 'Problems on Trains', 'Pole 4s 5s same speed. Cross?', '4.44s', '4.5s', '5s', '9s', 'A', 'Mean'),
        ('Quantitative', 'Problems on Trains', '100m 60kmph man 6kmph same. Time?', '6.66s', '6s', '7s', '5s', 'A', '100/15'),
        ('Quantitative', 'Problems on Trains', 'Which fastest?', '25 m/s', '90 kmph', 'Equal', 'None', 'C', 'Equal'),

        -- 🚣 BOATS AND STREAMS
        ('Quantitative', 'Boats and Streams', 'Down 15 Up 9. Still?', '12', '10', '11', '13', 'A', '12'),
        ('Quantitative', 'Boats and Streams', 'Boat 13 Stream 4. 68km Down?', '4 hr', '5 hr', '3 hr', '6 hr', 'A', '17kmph'),
        ('Quantitative', 'Boats and Streams', 'Down 20 Up 10. Stream?', '5', '4', '6', '3', 'A', '5'),
        ('Quantitative', 'Boats and Streams', '100d 10h, 75u 15h. Stream?', '2.5', '3', '2', '4', 'A', '2.5'),
        ('Quantitative', 'Boats and Streams', 'Row 5 Stream 1. 1hr trip. Dist?', '2.4 km', '2.5 km', '3 km', '2 km', 'A', '2.4'),
        ('Quantitative', 'Boats and Streams', 'Man 15 Stream 2.5. Up?', '12.5', '10', '15', '17.5', 'A', '12.5'),
        ('Quantitative', 'Boats and Streams', 'Double time up than down. Ratio?', '3:1', '2:1', '4:1', '1:2', 'A', '3:1'),
        ('Quantitative', 'Boats and Streams', '24u 36d 6h. 36u 24d 6.5h. Stream?', '2', '3', '1', '4', 'A', '2'),
        ('Quantitative', 'Boats and Streams', 'Still 9 Stream 1.5. 105km trip?', '24 hr', '20 hr', '22 hr', '25 hr', 'A', '24'),
        ('Quantitative', 'Boats and Streams', '40u 8h, 36d 6h. Stream?', '0.5', '1', '1.5', '2', 'A', '0.5'),
        ('Quantitative', 'Boats and Streams', 'B:S 5:1. Time Ratio?', '2:3', '3:2', '4:6', '5:6', 'A', '2:3'),
        ('Quantitative', 'Boats and Streams', '6km trip 2hr Stream 4. Boat?', '8', '6', '10', '12', 'A', '8'),
        ('Quantitative', 'Boats and Streams', 'Motor 15. 30km trip 4.5hr. Stream?', '5', '4', '3', '6', 'A', '5'),
        ('Quantitative', 'Boats and Streams', 'Boat 20. 150km trip River 10. Time?', '20 hr', '15 hr', '25 hr', '30 hr', 'A', '20'),
        ('Quantitative', 'Boats and Streams', '7km up 42min Stream 3. Still?', '13', '12', '10', '14', 'A', '13'),
        ('Quantitative', 'Boats and Streams', '1km d 5min, 1km u 12min. Stream?', '3.5', '3', '2.5', '4', 'A', '3.5'),
        ('Quantitative', 'Boats and Streams', 'Sailor 2 Stream 1. 12km trip?', '16 hr', '12 hr', '20 hr', '24 hr', 'A', '16'),
        ('Quantitative', 'Boats and Streams', 'Water 4 Boat 14. 12km up?', '1.2 hr', '1 hr', '1.5 hr', '2 hr', 'A', '1.2'),
        ('Quantitative', 'Boats and Streams', 'B:S 8:1. 67.5km d 5h. Stream?', '1.5', '1', '2', '2.5', 'A', '1.5'),
        ('Quantitative', 'Boats and Streams', '90min less 36mi d. B=10. Stream?', '2', '2.5', '3', '4', 'A', '2'),
        ('Quantitative', 'Boats and Streams', 'Cur 5. 10km trip 50min. Boat?', '25', '20', '30', '15', 'A', '25'),
        ('Quantitative', 'Boats and Streams', 'Man 6m/s Water 2m/s. Angle?', 'Formula', '90', '45', '60', 'A', 'Formula'),
        ('Quantitative', 'Boats and Streams', 'Speed B=x S=y Up?', 'x-y', 'x+y', 'xy', 'x/y', 'A', 'x-y'),
        ('Quantitative', 'Boats and Streams', 'Downstream speed?', 'B+S', 'B-S', 'B*S', 'B/S', 'A', 'B+S'),
        ('Quantitative', 'Boats and Streams', 'Man 9.33kmph Stream 4. Time?', 'Triple', 'Double', 'Quad', 'Same', 'A', 'Triple'),
        ('Quantitative', 'Boats and Streams', '12km up 4hr Stream 1.5. Down?', '6', '5', '4', '3', 'A', '6'),
        ('Quantitative', 'Boats and Streams', 'Time Up:Down 4:1. B:S?', '5:3', '3:5', '2:3', '5:2', 'A', '5:3'),
        ('Quantitative', 'Boats and Streams', 'Still 10 Up 5. Stream?', '2.5', '5', '2', '3', 'A', '2.5'),
        ('Quantitative', 'Boats and Streams', 'If B=S, Upstream?', '0', 'Speed', 'Double', 'None', 'A', '0'),
        ('Quantitative', 'Boats and Streams', 'Stream 2 Boat 8. 20km Down?', '2 hr', '3 hr', '1.5 hr', '2.5 hr', 'A', '2'),

        -- 👴 AGES
        ('Quantitative', 'Ages', 'A 2 times B. 10 ago 4 times. B?', '15', '20', '10', '25', 'A', '15'),
        ('Quantitative', 'Ages', 'Sum 60. 6 ago 5 times. Son?', '14', '15', '12', '10', 'A', '14'),
        ('Quantitative', 'Ages', '3:4. 5 later 4:5. A?', '15', '20', '25', '10', 'A', '15'),
        ('Quantitative', 'Ages', 'Diff 10. 15 ago twice. Elder?', '35', '30', '40', '25', 'A', '35'),
        ('Quantitative', 'Ages', 'Father 3 times. 10 later 2 times. Father?', '30', '40', '45', '35', 'A', '30'),
        ('Quantitative', 'Ages', 'A 3 times B. 10 later 2 times. A?', '30', '20', '40', '10', 'A', '30'),
        ('Quantitative', 'Ages', 'Father 30 more son. 5 ago 4 times. Son?', '15', '10', '20', '12', 'A', '15'),
        ('Quantitative', 'Ages', 'Sum 90. 10 ago 1:2:3. B?', '30', '20', '40', '25', 'A', '30'),
        ('Quantitative', 'Ages', '5:4. 3 later 11:9. A?', '30', '40', '35', '25', 'A', '30'),
        ('Quantitative', 'Ages', 'Mother 3 times. 5 ago 4 times. Daug?', '15', '10', '12', '20', 'A', '15'),
        ('Quantitative', 'Ages', '4:5. 18 ago 11:16. Sum?', '90', '80', '100', '110', 'A', '90'),
        ('Quantitative', 'Ages', 'Avg 30 is 15. Teacher 16. Teach?', '46', '45', '40', '50', 'A', '46'),
        ('Quantitative', 'Ages', 'Father 3 times. 8 later 2.5. Father?', '48', '50', '45', '40', 'A', '48'),
        ('Quantitative', 'Ages', 'Prod 240. 2A=N+4. N?', '12', '20', '10', '24', 'B', '12'),
        ('Quantitative', 'Ages', '3:4. 4 later 4:5. Q?', '16', '12', '20', '24', 'A', '16'),
        ('Quantitative', 'Ages', '10 ago 3x. 10 later 2x. Ratio?', '7:3', '5:2', '9:4', '2:1', 'A', '7:3'),
        ('Quantitative', 'Ages', 'Sum 27. Rel given. B?', '10', '8', '12', '9', 'A', '10'),
        ('Quantitative', 'Ages', 'Sum 42. 3 ago 5x. Diff?', '30', '25', '35', '20', 'A', '30'),
        ('Quantitative', 'Ages', 'Suresh half. 20 later 1.5. Father?', '40', '50', '60', '45', 'A', 'S=x, F=2x. F+20 = 1.5(S+20)'),
        ('Quantitative', 'Ages', 'Man 24 more. 2 later 2x. Son?', '22', '20', '24', '18', 'A', '22'),
        ('Quantitative', 'Ages', '5 kids 3yr gap. Sum 50. Young?', '4', '3', '5', '6', 'A', '4'),
        ('Quantitative', 'Ages', '4:7:9. 8 ago sum 56. Eldest?', '36', '40', '45', '30', 'A', '36'),
        ('Quantitative', 'Ages', '2/5 mother. 8 later 1/2. Mother?', '40', '45', '35', '50', 'A', '40'),
        ('Quantitative', 'Ages', 'Chain ratio. D=20. A?', '18', '20', '15', '25', 'A', '18'),
        ('Quantitative', 'Ages', 'Your age when born. F=38. S?', '19', '20', '18', '15', 'A', '19'),
        ('Quantitative', 'Ages', 'Diff 16. 6 ago 3x. Elder?', '30', '32', '28', '34', 'A', '30'),
        ('Quantitative', 'Ages', 'Avg HWC 27. WC 20. H?', '40', '35', '45', '50', 'A', '40'),
        ('Quantitative', 'Ages', '6:5. Sum 44. 8 later?', '8:7', '7:6', '9:8', '10:9', 'A', '8:7'),
        ('Quantitative', 'Ages', 'Kunal Sagar 6:5. 4 later 11:10. S?', '16', '18', '20', '15', 'A', '16'),
        ('Quantitative', 'Ages', 'A 100 B 10. Ratio?', '10:1', '1:10', '100:1', 'None', 'A', '10:1'),

        -- 🎲 PROBABILITY
        ('Quantitative', 'Probability', 'Head in coin toss?', '1/2', '1/3', '1/4', '1', 'A', '0.5'),
        ('Quantitative', 'Probability', 'Die 6?', '1/6', '1/2', '1/3', '5/6', 'A', '1/6'),
        ('Quantitative', 'Probability', '2 Coins 2 Heads?', '1/4', '1/2', '3/4', '1/3', 'A', '1/4'),
        ('Quantitative', 'Probability', 'King from pack?', '1/13', '1/52', '1/26', '1/4', 'A', '1/13'),
        ('Quantitative', 'Probability', '3R 5B. Blue?', '5/8', '3/8', '1/2', '1/4', 'A', '5/8'),
        ('Quantitative', 'Probability', '3 coins 2 heads?', '3/8', '1/2', '1/4', '1/8', 'A', '3/8'),
        ('Quantitative', 'Probability', 'Face card?', '3/13', '1/13', '4/13', '1/2', 'A', '3/13'),
        ('Quantitative', 'Probability', '2 Dice sum 9?', '1/9', '1/6', '1/12', '1/3', 'A', '1/9'),
        ('Quantitative', 'Probability', 'ASSASSINATION vowel?', '6/13', '7/13', '1/2', '5/13', 'A', '6/13'),
        ('Quantitative', 'Probability', '1-100 div 5?', '1/5', '1/4', '1/10', '1/20', 'A', '1/5'),
        ('Quantitative', 'Probability', 'Leap year 53 Sun?', '2/7', '1/7', '3/7', '1/2', 'A', '2/7'),
        ('Quantitative', 'Probability', '1-20 mult 3 or 5?', '9/20', '1/2', '8/20', '2/5', 'A', '9/20'),
        ('Quantitative', 'Probability', '2 cards Kings?', '1/221', '1/26', '1/200', '1/13', 'A', '1/221'),
        ('Quantitative', 'Probability', 'Ace or King?', '2/13', '1/13', '4/13', '1/52', 'A', '2/13'),
        ('Quantitative', 'Probability', '5R 4G. 2 Green?', '1/6', '1/5', '1/4', '1/3', 'A', '1/6'),
        ('Quantitative', 'Probability', 'Doublet dice?', '1/6', '1/12', '1/36', '1/4', 'A', '1/6'),
        ('Quantitative', 'Probability', '4 on die?', '1/6', '1/3', '1/2', '1/5', 'A', '1/6'),
        ('Quantitative', 'Probability', '6W 4B. 2 same?', '7/15', '1/3', '8/15', '1/2', 'A', '7/15'),
        ('Quantitative', 'Probability', 'Not Ace?', '12/13', '1/13', '11/13', '10/13', 'A', '12/13'),
        ('Quantitative', 'Probability', 'MOBILE vowel odd?', '1/6', '1/3', '1/2', '1/5', 'A', '1/6'),
        ('Quantitative', 'Probability', 'Truth 75 80. Contra?', '35%', '30%', '40%', '25%', 'A', '35'),
        ('Quantitative', 'Probability', '3 coins 1 head?', '7/8', '1/8', '3/8', '1/2', 'A', '7/8'),
        ('Quantitative', 'Probability', 'Prime 1-50?', '3/10', '1/2', '7/25', '1/5', 'A', '3/10'),
        ('Quantitative', 'Probability', 'Non leap 53 Mon?', '1/7', '2/7', '1/14', '1/2', 'A', '1/7'),
        ('Quantitative', 'Probability', '7R 5W. Not Red?', '5/12', '7/12', '1/2', '1/3', 'A', '5/12'),
        ('Quantitative', 'Probability', '1-50 Square?', '7/50', '3/25', '1/10', '1/5', 'A', '7/50'),
        ('Quantitative', 'Probability', 'Spade and Heart?', '13/102', '1/4', '1/2', '13/51', 'A', '13/102'),
        ('Quantitative', 'Probability', '3 dice sum 18?', '1/216', '1/108', '1/36', '1/72', 'A', '1/216'),
        ('Quantitative', 'Probability', '4R 5B 6W. White?', '2/5', '1/3', '1/2', '4/15', 'A', '2/5'),
        ('Quantitative', 'Probability', 'Both girls given 1?', '1/3', '1/2', '1/4', '2/3', 'A', '1/3'),

        -- ➗ HCF & LCM
        ('Quantitative', 'HCF & LCM', 'HCF 108 288 360?', '36', '18', '24', '12', 'A', '36'),
        ('Quantitative', 'HCF & LCM', 'LCM 24 36 40?', '360', '120', '240', '480', 'A', '360'),
        ('Quantitative', 'HCF & LCM', 'HCF 11 LCM 693. 77?', '99', '88', '110', '108', 'A', '99'),
        ('Quantitative', 'HCF & LCM', 'Least div 12 15 20 27?', '540', '360', '480', '600', 'A', '540'),
        ('Quantitative', 'HCF & LCM', 'Greatest div 43 91 183?', '4', '7', '9', '13', 'A', '4'),
        ('Quantitative', 'HCF & LCM', 'HCF 2 4 8?', '2', '4', '8', '1', 'A', '2'),
        ('Quantitative', 'HCF & LCM', 'LCM 5 10 15?', '30', '15', '50', '60', 'A', '30'),
        ('Quantitative', 'HCF & LCM', 'Prod 200 HCF 5 LCM?', '40', '20', '50', '10', 'A', '40'),
        ('Quantitative', 'HCF & LCM', 'Least div 12 15 20?', '60', '40', '50', '30', 'A', '60'),
        ('Quantitative', 'HCF & LCM', 'HCF primes?', '1', '0', '2', 'Prod', 'A', '1'),
        ('Quantitative', 'HCF & LCM', 'HCF frac 2/3...', '2/81', '2/3', '8/3', '8/81', 'A', '2/81'),
        ('Quantitative', 'HCF & LCM', 'LCM frac 2/3...', '36', '1/36', '12', '24', 'A', '36'),
        ('Quantitative', 'HCF & LCM', 'Ratio 3:4 HCF 4 LCM?', '48', '12', '16', '24', 'A', '48'),
        ('Quantitative', 'HCF & LCM', 'Sum 528 HCF 33. Pairs?', '4', '3', '2', '5', 'A', '4'),
        ('Quantitative', 'HCF & LCM', 'Greatest 4 digit div 15, 25, 40, 75?', '9000', '9400', '9600', '9800', 'C', 'LCM is 600. 9999/600 Rem 399. 9999-399=9600'),
        ('Quantitative', 'HCF & LCM', 'Prod 4107 HCF 37. Big?', '111', '107', '101', '85', 'A', '111'),
        ('Quantitative', 'HCF & LCM', '1:2:3 HCF 12?', '12,24,36', '10,20,30', '4,8,12', '5,10,15', 'A', '12,24,36'),
        ('Quantitative', 'HCF & LCM', 'Small 8 9 12 15 rem 1?', '361', '359', '181', '360', 'A', '361'),
        ('Quantitative', 'HCF & LCM', 'HCF 513 1134...?', '27', '18', '33', '36', 'A', '27'),
        ('Quantitative', 'HCF & LCM', 'Bells 2 4 6. 30min?', '16', '15', '20', '21', 'A', '16'),
        ('Quantitative', 'HCF & LCM', 'Inc 5 div 24 32?', '859', '869', '427', '864', 'A', '859'),
        ('Quantitative', 'HCF & LCM', 'Greater LCM 2310 HCF 30?', '330', '210', '165', '1155', 'A', '330'),
        ('Quantitative', 'HCF & LCM', 'HCF x,y is z. LCM?', 'xy/z', 'xyz', 'x/z', 'y/z', 'A', 'xy/z'),
        ('Quantitative', 'HCF & LCM', 'HCF powers?', 'Lowest', 'Highest', 'Prod', 'None', 'A', 'Lowest'),
        ('Quantitative', 'HCF & LCM', 'LCM 144 192?', '576', '480', '600', '720', 'A', '576'),
        ('Quantitative', 'HCF & LCM', 'LCM primes x y?', 'xy', 'x+y', 'x-y', 'x/y', 'A', 'xy'),
        ('Quantitative', 'HCF & LCM', '2:3 LCM 48. Sum?', '40', '64', '28', '44', 'A', '40'),
        ('Quantitative', 'HCF & LCM', 'HCF 0.63 1.05?', '0.21', '0.021', '2.1', '0.63', 'A', '0.21'),
        ('Quantitative', 'HCF & LCM', 'Least sq div 21...?', '213444', '214344', '231444', '200000', 'A', '213444'),
        ('Quantitative', 'HCF & LCM', 'Lights 48 72...?', '8:27:12', '8:25:00', '8:30:00', '8:22:00', 'A', '8:27:12'),

        -- 📉 AVERAGES
        ('Quantitative', 'Averages', 'Avg 10 20 30 40 50?', '30', '25', '35', '40', 'A', '30'),
        ('Quantitative', 'Averages', 'Avg 5 natural?', '3', '2.5', '3.5', '2', 'A', '3'),
        ('Quantitative', 'Averages', 'Avg 5 is 20. Sum?', '100', '80', '120', '50', 'A', '100'),
        ('Quantitative', 'Averages', '3 boys 15. 3:5:7. Young?', '9', '15', '12', '21', 'A', '9'),
        ('Quantitative', 'Averages', '10 inn 40. Next 100. New?', '45.45', '50', '44', '42', 'A', '45.45'),
        ('Quantitative', 'Averages', 'Avg 10 primes?', '12.9', '10.1', '11.5', '13.2', 'A', '12.9'),
        ('Quantitative', 'Averages', 'Avg 25 18. 12 14 12 17. 13th?', '78', '75', '80', '72', 'A', '78'),
        ('Quantitative', 'Averages', '5 odd 61. Diff?', '8', '10', '12', '6', 'A', '8'),
        ('Quantitative', 'Averages', 'Sun 510 Other 240. Month?', '285', '290', '300', '250', 'A', '285'),
        ('Quantitative', 'Averages', '8 men inc 2.5. 65 rep?', '85', '80', '75', '90', 'A', '85'),
        ('Quantitative', 'Averages', '50 is 38. Drop 45 55?', '37.5', '36.5', '38.5', '39', 'A', '37.5'),
        ('Quantitative', 'Averages', 'Mean 50 is 36. 48 as 23. Cor?', '36.5', '35.5', '37.5', '38', 'A', '36.5'),
        ('Quantitative', 'Averages', 'Marr 23. 5yr child. Fam?', '19', '23', '20', '18', 'A', '19'),
        ('Quantitative', 'Averages', '3yr ago 17. Baby. Same. Baby?', '2', '3', '1', '4', 'A', '2'),
        ('Quantitative', 'Averages', '10 inn 32. Need 36?', '76', '70', '65', '80', 'A', '76'),
        ('Quantitative', 'Averages', '5 mon sale. 6th?', '4991', '5000', '5500', '4500', 'A', '4991'),
        ('Quantitative', 'Averages', '3 num 28. Relations. 3rd?', '48', '36', '24', '18', 'A', '48'),
        ('Quantitative', 'Averages', '9th spent 20 more. 9th?', '52.5', '50', '55', '45', 'A', '52.5'),
        ('Quantitative', 'Averages', 'Avg 20 is 0. Max pos?', '19', '10', '1', '0', 'A', '19'),
        ('Quantitative', 'Averages', 'Avg odd 100?', '50', '51', '49.5', '49', 'A', '50'),
        ('Quantitative', 'Averages', 'Avg sq 10?', '38.5', '40.5', '35.5', '42.5', 'A', '38.5'),
        ('Quantitative', 'Averages', '15.8. 16.4 15.4. Ratio?', '2:3', '1:2', '3:2', '3:1', 'A', '2:3'),
        ('Quantitative', 'Averages', '20 work 1500. Man 1550?', '2550', '2600', '2400', '2500', 'A', '2550'),
        ('Quantitative', 'Averages', 'Avg a,b,c 45. b?', '31', '26', '20', '15', 'A', '31'),
        ('Quantitative', 'Averages', 'Avg 7. Mult 12. New?', '84', '70', '19', '7', 'A', '84'),
        ('Quantitative', 'Averages', 'Mean 1 2 x 4 5 is 3. x?', '3', '2', '4', '1', 'A', '3'),
        ('Quantitative', 'Averages', 'Avg XY YX?', '11/2', 'XY', 'Sum', 'None', 'A', '11/2'),
        ('Quantitative', 'Averages', '7 consec 20. Big?', '23', '22', '21', '24', 'A', '23'),
        ('Quantitative', 'Averages', 'Mean 20 is 20. Drop 2?', 'Depends', '20', '18', 'None', 'A', 'Depends'),
        ('Quantitative', 'Averages', 'Capt 26 WK 29. Others?', '23', '22', '24', '25', 'A', '23'),

        -- 💰 SIMPLE INTEREST
        ('Quantitative', 'Simple Interest', 'P=1000 10% 2yr?', '200', '100', '300', '150', 'A', '200'),
        ('Quantitative', 'Simple Interest', 'Double 10yr. Rate?', '10%', '5%', '15%', '20%', 'A', '10%'),
        ('Quantitative', 'Simple Interest', '5000 5% 4yr?', '1000', '2000', '500', '1500', 'A', '1000'),
        ('Quantitative', 'Simple Interest', 'Amt 1200 P 1000?', '200', '100', '300', '400', 'A', '200'),
        ('Quantitative', 'Simple Interest', '500 to 600 5%?', '4 yr', '2 yr', '3 yr', '5 yr', 'A', '4 yr'),
        ('Quantitative', 'Simple Interest', 'P=5000 5% 5yr?', '1250', '1500', '1000', '2000', 'A', '1250'),
        ('Quantitative', 'Simple Interest', '2700 2yr 3500 4yr. Sum?', '1900', '1500', '2000', '1800', 'A', '1900'),
        ('Quantitative', 'Simple Interest', 'Double 8yr. Rate?', '12.5%', '10%', '15%', '20%', 'A', '12.5%'),
        ('Quantitative', 'Simple Interest', '3yr 10% 300. Sum?', '1000', '1200', '1500', '2000', 'A', '1000'),
        ('Quantitative', 'Simple Interest', 'Diff 2yr 3yr 100. Sum?', '1000', '2000', '500', '1500', 'A', '1000'),
        ('Quantitative', 'Simple Interest', '7/6 3yr. Rate?', '5.55%', '5%', '6%', '4%', 'A', '5.55%'),
        ('Quantitative', 'Simple Interest', '3% more 72 more. Sum?', '1200', '1000', '1500', '1800', 'A', '1200'),
        ('Quantitative', 'Simple Interest', 'Mixed 10yr 1850. Sum?', '2500', '2000', '3000', '1500', 'A', '2500'),
        ('Quantitative', 'Simple Interest', '4/9 sum R=T. Rate?', '6.66%', '6%', '5%', '7%', 'A', '6.66%'),
        ('Quantitative', 'Simple Interest', '800 956 4% more?', '1052', '1020', '1000', '1100', 'A', '1052'),
        ('Quantitative', 'Simple Interest', '10000 8 10 avg 9.2. 8?', '4000', '6000', '5000', '3000', 'A', '4000'),
        ('Quantitative', 'Simple Interest', 'Double 6yr. 4x?', '18 yr', '24 yr', '12 yr', '15 yr', 'A', '18 yr'),
        ('Quantitative', 'Simple Interest', '5000 2y 3000 4y 2200?', '10%', '5%', '8%', '12%', 'A', '10%'),
        ('Quantitative', 'Simple Interest', '720 2y 1020 7y. Sum?', '600', '500', '700', '400', 'A', '600'),
        ('Quantitative', 'Simple Interest', 'Eq SI x,y. x/y?', 'ns/mr', 'mr/ns', 'nr/ms', 'ms/nr', 'A', 'ns/mr'),
        ('Quantitative', 'Simple Interest', '1500 5 8 300 3y. 5?', '500', '800', '1000', '1200', 'A', '500'),
        ('Quantitative', 'Simple Interest', '4y 5, 6y 8. 1000?', '680', '600', '500', '400', 'A', '680'),
        ('Quantitative', 'Simple Interest', 'Population 8000. Men inc 6%, women 10%. Total 8600. Men?', '5000', '4000', '3000', '6000', 'A', '5000'),
        ('Quantitative', 'Simple Interest', 'SI Rs1 less P. 10 4?', '1.66', '2', '5', '1', 'A', '1.66'),
        ('Quantitative', 'Simple Interest', 'Debt 848 4y 4%. Inst?', '200', '212', '220', '225', 'A', '200'),
        ('Quantitative', 'Simple Interest', '16/25 P R=T?', '8%', '6%', '5%', '10%', 'A', '8%'),
        ('Quantitative', 'Simple Interest', '10% 6mo?', '0.05P', '0.1P', '0.01P', '0.5P', 'A', '0.05P'),
        ('Quantitative', 'Simple Interest', '2240 2y 2600 5y. Sum?', '2000', '1900', '2100', '1800', 'A', '2000'),
        ('Quantitative', 'Simple Interest', 'Mixed 12y 1560. Sum?', '1000', '1500', '2000', '1200', 'A', '1000'),
        ('Quantitative', 'Simple Interest', 'Recurring?', 'Formula', 'No', 'Yes', 'Skip', 'A', 'Formula'),

        -- ⚖️ RATIO
        ('Quantitative', 'Ratio & Proportion', 'A:B 2:3 B:C 4:5. ABC?', '8:12:15', '2:3:5', '8:12:10', '6:9:15', 'A', '8:12:15'),
        ('Quantitative', 'Ratio & Proportion', '100 2:3?', '40, 60', '30, 70', '50, 50', '20, 80', 'A', '40, 60'),
        ('Quantitative', 'Ratio & Proportion', '4th prop 4 8 12?', '24', '20', '16', '32', 'A', '24'),
        ('Quantitative', 'Ratio & Proportion', 'Mean prop 4 16?', '8', '10', '12', '6', 'A', '8'),
        ('Quantitative', 'Ratio & Proportion', '0.75:x 5:8. x?', '1.2', '1.1', '1.5', '1.0', 'A', '1.2'),
        ('Quantitative', 'Ratio & Proportion', '3:4 x:y exp?', '32:7', '7:32', '4:3', '5:2', 'A', '32:7'),
        ('Quantitative', 'Ratio & Proportion', '3:5 sub 9 12:23?', '33, 55', '30, 50', '36, 60', '24, 40', 'A', '33, 55'),
        ('Quantitative', 'Ratio & Proportion', '7:5 720. 1:1 add?', '120', '100', '150', '80', 'A', '120'),
        ('Quantitative', 'Ratio & Proportion', '2:3:5 inc 15 10 20?', '23:33:60', '20:30:50', '25:35:65', '22:32:52', 'A', '23:33:60'),
        ('Quantitative', 'Ratio & Proportion', 'Sum 98. 2:3 5:8. 2nd?', '30', '20', '48', '58', 'A', '30'),
        ('Quantitative', 'Ratio & Proportion', '3rd prop 9 12?', '16', '15', '20', '24', 'A', '16'),
        ('Quantitative', 'Ratio & Proportion', '5:7:8 inc 40 50 75?', '2:3:4', '2:3:5', '4:5:6', '7:10:14', 'A', '2:3:4'),
        ('Quantitative', 'Ratio & Proportion', 'Coins 5:9:4 206. 25p?', '360', '200', '160', '180', 'A', '360'),
        ('Quantitative', 'Ratio & Proportion', '5:7 6:11. ABC?', '30:42:77', '30:40:70', '35:49:77', 'None', 'A', '30:42:77'),
        ('Quantitative', 'Ratio & Proportion', '2A=3B=4C?', '6:4:3', '2:3:4', '4:3:2', '3:4:6', 'A', '6:4:3'),
        ('Quantitative', 'Ratio & Proportion', '60L 2:1. 1:2 add?', '60 L', '20 L', '40 L', '30 L', 'A', '60'),
        ('Quantitative', 'Ratio & Proportion', '782 1/2 2/3 3/4. 1st?', '204', '190', '196', '200', 'A', '204'),
        ('Quantitative', 'Ratio & Proportion', '19x 9x to 15x?', '3:2', '2:3', '1:2', '2:1', 'A', '3:2'),
        ('Quantitative', 'Ratio & Proportion', 'Inv sq Y. X=1 Y=2. Y=6?', '1/9', '1/3', '3', '9', 'A', '1/9'),
        ('Quantitative', 'Ratio & Proportion', 'Earth 1:2 N 2:3. S?', '4:11', '1:3', '2:5', '3:5', 'A', '4:11'),
        ('Quantitative', 'Ratio & Proportion', '3:2 5:3 save 1000?', '6000', '4000', '5000', '3000', 'A', '6000'),
        ('Quantitative', 'Ratio & Proportion', 'Mean 0.02 0.32?', '0.08', '0.04', '0.16', '0.3', 'A', '0.08'),
        ('Quantitative', 'Ratio & Proportion', 'Complex A:B:C:D?', '8:6:10:9', '4:6:8:10', '6:4:8:10', '8:6:9:10', 'A', '8:6:10:9'),
        ('Quantitative', 'Ratio & Proportion', 'Prop 1/27 3/7 3/7?', '1/49', '1/25', '1/30', '1/70', 'A', '1/49'),
        ('Quantitative', 'Ratio & Proportion', '7:3 add 6L 7:6. Milk?', '14', '21', '28', '35', 'A', '14'),
        ('Quantitative', 'Ratio & Proportion', '7:5 1200. 1:1 add?', '200', '100', '150', '50', 'A', '200'),
        ('Quantitative', 'Ratio & Proportion', 'Zinc 5:3. 3:5 add?', '133.3', '100', '120', '150', 'A', '133.3'),
        ('Quantitative', 'Ratio & Proportion', 'Duplicate 3:4?', '9:16', '27:64', 'Sqrt', '6:8', 'A', '9:16'),
        ('Quantitative', 'Ratio & Proportion', 'Compounded 2:3...?', '2:1', '1:2', '3:2', '2:3', 'A', '2:1'),
        ('Quantitative', 'Ratio & Proportion', 'Chain 2:3 4:5 6:7. A:D?', '16:35', '8:15', '2:7', '4:7', 'A', '16:35'),

        -- 🧠 LOGICAL: NUMBER SERIES (30 Questions)
        ('Logical', 'Number Series', '2, 4, 8, 16, ?', '30', '32', '24', '18', 'B', 'Double the previous number'),
        ('Logical', 'Number Series', '3, 6, 12, 24, ?', '40', '48', '36', '60', 'B', 'x2 logic'),
        ('Logical', 'Number Series', '10, 100, 200, 310, ?', '430', '420', '410', '400', 'A', 'Diff: 90, 100, 110, 120. 310+120=430'),
        ('Logical', 'Number Series', '1, 4, 9, 16, 25, ?', '30', '36', '49', '32', 'B', 'Squares: 6^2'),
        ('Logical', 'Number Series', '0, 7, 26, 63, ?', '124', '125', '100', '99', 'A', 'n^3 - 1. 5^3-1=124'),
        ('Logical', 'Number Series', '5, 10, 13, 26, 29, ?', '58', '60', '50', '55', 'A', 'x2, +3, x2, +3, x2. 29*2=58'),
        ('Logical', 'Number Series', '7, 12, 19, 28, 39, ?', '50', '51', '52', '55', 'C', 'Diff: 5, 7, 9, 11, 13. 39+13=52'),
        ('Logical', 'Number Series', '1, 1, 2, 6, 24, ?', '100', '120', '110', '140', 'B', 'x1, x2, x3, x4, x5'),
        ('Logical', 'Number Series', '120, 99, 80, 63, 48, ?', '35', '30', '32', '40', 'A', 'n^2 - 1 descending. 6^2-1=35'),
        ('Logical', 'Number Series', '2, 3, 5, 7, 11, ?', '12', '13', '14', '15', 'B', 'Prime numbers'),
        ('Logical', 'Number Series', '5, 11, 24, 51, 106, ?', '210', '215', '217', '220', 'C', 'x2 + 1, x2 + 2, x2 + 3... 106*2+5=217'),
        ('Logical', 'Number Series', '4, 10, ?, 82, 244', '20', '28', '24', '30', 'B', 'x3 - 2. 10*3-2=28. 28*3-2=82'),
        ('Logical', 'Number Series', '3, 7, 23, 95, ?', '479', '400', '350', '500', 'A', 'x4 - 5? No. x2+1, x3+2, x4+3, x5+4. 95*5+4=479'),
        ('Logical', 'Number Series', '6, 13, 25, 51, 101, ?', '201', '202', '203', '205', 'C', 'x2 + 1, x2 - 1... 6*2+1=13, 13*2-1=25, 25*2+1=51, 51*2-1=101, 101*2+1=203'),
        ('Logical', 'Number Series', '8, 28, 116, 584, ?', '1752', '3504', '3508', '3502', 'C', 'x3+4, x4+4, x5+4... 584*6+4'),
        ('Logical', 'Number Series', '198, 194, 185, 169, ?', '144', '136', '150', '100', 'A', 'Diff: -4, -9, -16 (Squares). Next -25. 169-25=144'),
        ('Logical', 'Number Series', '1, 2, 3, 5, 8, ?', '11', '13', '15', '12', 'B', 'Fibonacci. 5+8=13'),
        ('Logical', 'Number Series', '2, 12, 36, 80, 150, ?', '250', '252', '240', '260', 'B', 'n^3 + n^2. 1^3+1=2... 6^3+6^2=252'),
        ('Logical', 'Number Series', '4, 6, 12, 14, 28, 30, ?', '60', '62', '58', '56', 'A', '+2, x2, +2, x2, +2, x2. 30*2=60'),
        ('Logical', 'Number Series', '1, 2, 6, 24, ?', '100', '120', '110', '90', 'B', 'Factorials. 5! = 120'),
        ('Logical', 'Number Series', '10, 18, 28, 40, 54, 70, ?', '85', '87', '88', '90', 'C', 'Diff: 8, 10, 12, 14, 16. Next 18. 70+18=88'),
        ('Logical', 'Number Series', '120, 99, 80, 63, 48, ?', '35', '36', '38', '39', 'A', '11^2-1, 10^2-1... 6^2-1=35'),
        ('Logical', 'Number Series', '22, 24, 28, ?', '52', '42', '36', '34', 'C', 'Pattern diff +2, +4, +8. 28+8=36'),
        ('Logical', 'Number Series', '5, 6, 9, 15, ?, 40', '21', '25', '27', '33', 'B', 'Diff 1, 3, 6, 10 (Triangular). 15+10=25'),
        ('Logical', 'Number Series', '2, 3, 5, 6, 7, 9, 10, 11, 13, ?', '12', '15', '14', '16', 'C', 'Composite skipped? No. Check +1, +2 pattern. Alt series'),
        ('Logical', 'Number Series', '4, 9, 25, ?, 121', '64', '49', '81', '100', 'B', 'Squares of primes. 2,3,5,7. 7^2=49'),
        ('Logical', 'Number Series', '11, 13, 17, 19, 23, 25, ?', '26', '27', '29', '31', 'B', '+2, +4, +2, +4... 23+2=25, 25+4=29. But option 27? Wait pattern. Primes? 25 is not. Alt +2, +4 pattern.'),
        ('Logical', 'Number Series', '6, 12, 21, ?', '33', '38', '40', '45', 'A', '+6, +9, +12. 21+12=33'),
        ('Logical', 'Number Series', '2, 5, 9, ?, 20, 27', '14', '16', '18', '24', 'A', '+3, +4, +5 (9+5=14), +6 (14+6=20)'),
        ('Logical', 'Number Series', '3, 12, 27, 48, 75, ?', '100', '108', '110', '120', 'B', '3*1^2, 3*2^2, 3*3^2... 3*6^2=108'),

        -- 🗣️ VERBAL: SPOTTING ERRORS (30 Questions)
        ('Verbal', 'Spotting Errors', 'He run fastly.', 'He', 'run', 'fastly', 'No error', 'C', 'Fastly is wrong. Should be fast'),
        ('Verbal', 'Spotting Errors', 'One of the boys are missing.', 'One', 'of the', 'boys are', 'missing', 'C', 'Should be "is missing"'),
        ('Verbal', 'Spotting Errors', 'She dont know the answer.', 'She', 'dont', 'know', 'the answer', 'B', 'Should be "does not"'),
        ('Verbal', 'Spotting Errors', 'I prefer coffee than tea.', 'I', 'prefer', 'coffee', 'than tea', 'D', 'Prefer takes "to", not "than"'),
        ('Verbal', 'Spotting Errors', 'He is senior than me.', 'He', 'is', 'senior', 'than me', 'D', 'Senior takes "to"'),
        ('Verbal', 'Spotting Errors', 'Unless you do not work hard, you will fail.', 'Unless', 'you do not', 'work hard', 'you will fail', 'B', 'Unless is negative, dont use not'),
        ('Verbal', 'Spotting Errors', 'The sceneries of Kashmir is beautiful.', 'The', 'sceneries', 'of Kashmir', 'is beautiful', 'B', 'Scenery is uncountable. "Scenery"'),
        ('Verbal', 'Spotting Errors', 'Mathematics are my favorite subject.', 'Mathematics', 'are', 'my', 'favorite', 'B', 'Mathematics is singular. Use "is"'),
        ('Verbal', 'Spotting Errors', 'He has returned back.', 'He', 'has', 'returned', 'back', 'D', 'Return implies back. Remove back'),
        ('Verbal', 'Spotting Errors', 'Each of the girls have a bag.', 'Each', 'of the girls', 'have', 'a bag', 'C', 'Each takes singular "has"'),
        ('Verbal', 'Spotting Errors', 'Bread and butter are my breakfast.', 'Bread', 'and butter', 'are', 'my breakfast', 'C', 'Considered one unit. Use "is"'),
        ('Verbal', 'Spotting Errors', 'She is good in English.', 'She', 'is', 'good', 'in English', 'D', 'Good "at" English'),
        ('Verbal', 'Spotting Errors', 'He is married with a doctor.', 'He', 'is', 'married', 'with a doctor', 'D', 'Married "to"'),
        ('Verbal', 'Spotting Errors', 'I have seen him yesterday.', 'I have', 'seen', 'him', 'yesterday', 'A', 'Yesterday requires simple past "saw"'),
        ('Verbal', 'Spotting Errors', 'No sooner did I reached the station.', 'No sooner', 'did I', 'reached', 'the station', 'C', 'Did + V1. "reach"'),
        ('Verbal', 'Spotting Errors', 'The police is coming.', 'The', 'police', 'is', 'coming', 'C', 'Police is plural. "are"'),
        ('Verbal', 'Spotting Errors', 'He does not listen me.', 'He', 'does not', 'listen', 'me', 'C', 'Listen "to" me'),
        ('Verbal', 'Spotting Errors', 'We discussed about the matter.', 'We', 'discussed', 'about', 'the matter', 'C', 'Discuss does not take about'),
        ('Verbal', 'Spotting Errors', 'He entered into the room.', 'He', 'entered', 'into', 'the room', 'C', 'Entered the room (no into)'),
        ('Verbal', 'Spotting Errors', 'I am looking forward to meet you.', 'I am', 'looking forward', 'to', 'meet you', 'D', 'to "meeting" you'),
        ('Verbal', 'Spotting Errors', 'This is the best of the two.', 'This is', 'the best', 'of', 'the two', 'B', 'For two, use comparative "better"'),
        ('Verbal', 'Spotting Errors', 'Neither of the men were present.', 'Neither', 'of the men', 'were', 'present', 'C', 'Neither takes singular "was"'),
        ('Verbal', 'Spotting Errors', 'I am used to drive on the left.', 'I am', 'used to', 'drive', 'on the left', 'C', 'used to "driving"'),
        ('Verbal', 'Spotting Errors', 'It is I who is to blame.', 'It is', 'I', 'who is', 'to blame', 'C', 'Who refers to I. "am to blame"'),
        ('Verbal', 'Spotting Errors', 'She is one of the girl who won.', 'She is', 'one of', 'the girl', 'who won', 'C', 'One of the "girls"'),
        ('Verbal', 'Spotting Errors', 'The cattle is grazing.', 'The', 'cattle', 'is', 'grazing', 'C', 'Cattle is plural. "are"'),
        ('Verbal', 'Spotting Errors', 'He gave me an advice.', 'He', 'gave me', 'an advice', 'None', 'C', 'Advice is uncountable. "some advice"'),
        ('Verbal', 'Spotting Errors', 'Though he is rich but he is miser.', 'Though', 'he is rich', 'but', 'he is miser', 'C', 'Use "yet" or comma, not but'),
        ('Verbal', 'Spotting Errors', 'I wish I was a king.', 'I wish', 'I', 'was', 'a king', 'C', 'Subjunctive mood "were"'),
        ('Verbal', 'Spotting Errors', 'Ten miles are a long distance.', 'Ten miles', 'are', 'a long', 'distance', 'B', 'Distance unit is singular. "is"'),

        -- 💻 CODING: C PROGRAMMING (30 Questions)
        ('Coding', 'C Programming', 'Who is the father of C language?', 'Bjarne Stroustrup', 'James Gosling', 'Dennis Ritchie', 'Dr. E.F. Codd', 'C', 'Dennis Ritchie at Bell Labs'),
        ('Coding', 'C Programming', 'Size of int in C?', '2 bytes', '4 bytes', 'Compiler dependent', '8 bytes', 'C', 'Usually 4, but depends'),
        ('Coding', 'C Programming', 'Which is not a valid keyword?', 'volatile', 'friend', 'sizeof', 'auto', 'B', 'friend is C++'),
        ('Coding', 'C Programming', 'Operator with highest priority?', '++', '%', '+', '||', 'A', 'Increment'),
        ('Coding', 'C Programming', 'Format specifier for string?', '%d', '%c', '%s', '%f', 'C', '%s for string'),
        ('Coding', 'C Programming', 'Loop guaranteed to execute once?', 'for', 'while', 'do-while', 'None', 'C', 'Exit controlled loop'),
        ('Coding', 'C Programming', 'Return type of malloc()?', 'int*', 'void*', 'char*', 'null', 'B', 'Generic pointer'),
        ('Coding', 'C Programming', 'Which function reads a line?', 'scanf', 'gets', 'getch', 'printf', 'B', 'gets or fgets'),
        ('Coding', 'C Programming', 'Array index starts from?', '1', '0', '-1', 'None', 'B', 'Zero based'),
        ('Coding', 'C Programming', 'Value of EOF?', '0', '1', '-1', 'Null', 'C', 'Usually -1'),
        ('Coding', 'C Programming', 'Which is logical AND?', '&', '&&', 'AND', '||', 'B', '&& operator'),
        ('Coding', 'C Programming', 'File extension for C?', '.c', '.cpp', '.java', '.py', 'A', '.c file'),
        ('Coding', 'C Programming', 'Bitwise XOR operator?', '^', '&', '|', '~', 'A', 'Caret symbol'),
        ('Coding', 'C Programming', 'Header for printf?', 'conio.h', 'stdio.h', 'math.h', 'stdlib.h', 'B', 'Standard Input Output'),
        ('Coding', 'C Programming', 'Correct way to declare pointer?', 'int x*', 'int *x', 'int &x', 'ptr x', 'B', 'Asterisk before name'),
        ('Coding', 'C Programming', 'Break statement is used to?', 'Quit program', 'Quit current iteration', 'Exit loop/switch', 'None', 'C', 'Exits immediate block'),
        ('Coding', 'C Programming', 'Continue statement?', 'Restarts loop', 'Skips current iteration', 'Exits loop', 'None', 'B', 'Goes to next iteration'),
        ('Coding', 'C Programming', 'Storage class static?', 'Persists value', 'Global only', 'Local only', 'None', 'A', 'Retains value between calls'),
        ('Coding', 'C Programming', 'Which is not a loop?', 'for', 'while', 'do-while', 'repeat-until', 'D', 'repeat-until is Pascal'),
        ('Coding', 'C Programming', 'Structure members accessed by?', '.', '->', 'Both', 'None', 'C', 'Dot for obj, Arrow for ptr'),
        ('Coding', 'C Programming', 'Size of char?', '1 byte', '2 bytes', '4 bytes', '8 bytes', 'A', 'Always 1 byte'),
        ('Coding', 'C Programming', 'Ternary operator?', '?:', '::', '->', '.', 'A', 'Conditional operator'),
        ('Coding', 'C Programming', 'Function to compare strings?', 'strcat', 'strcmp', 'strcpy', 'strlen', 'B', 'String Compare'),
        ('Coding', 'C Programming', 'Which is volatile memory?', 'RAM', 'ROM', 'Hard Disk', 'CD', 'A', 'Lost on power off'),
        ('Coding', 'C Programming', 'What is NULL?', '0', '(void*)0', 'Both', 'None', 'C', 'Zero cast to void*'),
        ('Coding', 'C Programming', 'Command to compile in GCC?', 'gcc file.c', 'run file.c', 'c file.c', 'make file', 'A', 'GNU C Compiler'),
        ('Coding', 'C Programming', 'Default return of main?', 'void', 'int', 'float', 'char', 'B', 'Standard says int'),
        ('Coding', 'C Programming', 'Recursion is?', 'Looping', 'Function calling itself', 'Structure', 'Class', 'B', 'Self call'),
        ('Coding', 'C Programming', 'Invalid variable name?', 'var_1', '1var', 'var1', '_var', 'B', 'Cannot start with digit'),
        ('Coding', 'C Programming', 'Use of #include?', 'Linker', 'Preprocessor', 'Compiler', 'Execution', 'B', 'Preprocessor directive');
        `;
        
        await db.query(sql);
        res.send("<h1>✅ FINAL FIX DONE! V3 - All Sections Loaded (360+ Questions). <a href='/'>Go Home</a></h1>");
    } catch(err) { 
        console.error(err);
        res.send("Error: " + err.message); 
    }
});

// 🔥 STEP 4: Start Server (MUST BE AT THE VERY BOTTOM)
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
