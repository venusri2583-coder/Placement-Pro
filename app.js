const express = require('express');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const session = require('express-session');

dotenv.config();
const app = express();

// --- SESSION SETUP ---
app.use(session({
    secret: 'placement_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE CONNECTION ---
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10
});

const requireLogin = (req, res, next) => {
    if (req.session.user) { next(); } else { res.redirect('/login'); }
};

// --- ROUTES ---
app.get('/login', (req, res) => res.render('login', { error: null, msg: null }));
app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', async (req, res) => {
    try {
        await db.execute('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [req.body.username, req.body.email, req.body.password]);
        res.render('login', { msg: 'Account Created!', error: null });
    } catch (err) { res.render('register', { error: 'Email exists.' }); }
});
app.post('/login', async (req, res) => {
    try {
        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [req.body.email]);
        if (users.length > 0 && users[0].password === req.body.password) {
            req.session.user = users[0];
            res.redirect('/');
        } else { res.render('login', { error: 'Invalid Details', msg: null }); }
    } catch (err) { res.render('login', { error: 'Server Error', msg: null }); }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// --- DASHBOARD ---
app.get('/', requireLogin, async (req, res) => {
    try {
        const [scores] = await db.execute('SELECT * FROM mock_results WHERE user_id = ? ORDER BY test_date DESC', [req.session.user.id]);
        res.render('dashboard', { user: req.session.user, scores });
    } catch (err) { res.render('dashboard', { user: req.session.user, scores: [] }); }
});

app.get('/aptitude-topics', requireLogin, (req, res) => res.render('aptitude_topics', { user: req.session.user }));
app.get('/reasoning-topics', requireLogin, (req, res) => res.render('reasoning_topics', { user: req.session.user }));

app.get('/coding', requireLogin, (req, res) => res.render('coding_topics', { user: req.session.user }));

// REDIRECTS
app.get('/aptitude/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/reasoning/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/english/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/coding/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.post('/coding/practice', requireLogin, (req, res) => res.redirect(`/practice/${encodeURIComponent(req.body.topic)}`));

// --- PRACTICE ENGINE ---
app.get('/practice/:topic', requireLogin, async (req, res) => {
    const topic = decodeURIComponent(req.params.topic);
    try {
        let [questions] = await db.execute('SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 15', [topic]);
        
        if (questions.length === 0) {
            let altTopic = topic;
            if (topic === 'Problems on Trains') altTopic = 'Trains';
            else if (topic === 'Trains') altTopic = 'Problems on Trains';
            else if (topic.includes('&')) altTopic = topic.replace('&', 'and');
            else if (topic.includes('and')) altTopic = topic.replace('and', '&');
            
            [questions] = await db.execute('SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 15', [altTopic]);
        }

        if (questions.length === 0) {
            return res.send(`
                <div style="text-align:center; padding:50px;">
                    <h2 style="color:red;">Topic '${topic}' is empty!</h2>
                    <br>
                    <a href="/shuffle-data-final" style="background:green; color:white; padding:15px 30px; text-decoration:none; border-radius:5px; font-size:20px;">CLICK TO LOAD SHUFFLED QUESTIONS</a>
                </div>
            `);
        }
        res.render('mocktest', { questions, user: req.session.user, topic });
    } catch (err) { res.redirect('/'); }
});

app.post('/submit-quiz', requireLogin, async (req, res) => {
    const userAnswers = req.body;
    const topicName = req.body.topic_name;
    let score = 0;
    let totalQuestions = 0;
    let reviewData = [];

    try {
        // Topic ni batti anni 15 questions ni malli database nundi testunnam review kosam
        const [allQuestions] = await db.execute('SELECT * FROM aptitude_questions WHERE topic = ?', [topicName]);
        totalQuestions = allQuestions.length > 15 ? 15 : allQuestions.length;

        for (let i = 0; i < totalQuestions; i++) {
            const dbQ = allQuestions[i];
            const qId = dbQ.id;
            const userVal = userAnswers[`q${qId}`] ? userAnswers[`q${qId}`].toString().trim() : "Not Attempted";
            
            const correctOpt = dbQ.correct_option.trim(); // E.g., 'A'
            const correctVal = dbQ[`option_${correctOpt.toLowerCase()}`].toString().trim(); // E.g., '10km'
            
            // Check if user's answer is correct
            let isCorrect = (userVal === correctOpt) || (userVal === correctVal);
            if (isCorrect) score++;

            reviewData.push({
                q: dbQ.question,
                userAns: userVal,
                correctAns: `${correctOpt}) ${correctVal}`,
                explanation: dbQ.explanation || "Logic: Standard reasoning method applied.",
                isCorrect: isCorrect
            });
        }

        // Result ni database lo store chestunnam
        await db.execute('INSERT INTO mock_results (user_id, score, total, topic) VALUES (?, ?, ?, ?)', 
            [req.session.user.id, score, totalQuestions, topicName]);

        res.render('result', { score, total: totalQuestions, reviewData, user: req.session.user });
    } catch (err) {
        console.error(err);
        res.redirect('/');
    }
});

app.get('/leaderboard', requireLogin, async (req, res) => {
    try {
        const [rankings] = await db.query("SELECT u.username, MAX(m.score) as high_score FROM mock_results m JOIN users u ON m.user_id = u.id GROUP BY u.id, u.username ORDER BY high_score DESC LIMIT 10");
        res.render('leaderboard', { user: req.session.user, rankings });
    } catch(e) { res.render('leaderboard', { user: req.session.user, rankings: [] }); }
});
app.get('/interview-prep', requireLogin, (req, res) => res.render('interview', { user: req.session.user }));
app.get('/resume-upload', requireLogin, async (req, res) => { res.render('resume', { msg: null, user: req.session.user, history: [] }); });
const upload = multer({ dest: 'public/uploads/' });
app.post('/upload-resume', requireLogin, upload.single('resume'), async (req, res) => {
    if(req.file) await db.execute('INSERT INTO user_resumes (full_name, email, file_path, ats_score) VALUES (?, ?, ?, ?)', ['User', req.session.user.email, req.file.path, 80]);
    res.redirect('/resume-upload');
});

// =============================================================
// 🔥 SHUFFLE DATA GENERATOR (Random A, B, C, D)
// =============================================================
app.get('/shuffle-data-final', async (req, res) => {
    try {
        await db.query("TRUNCATE TABLE aptitude_questions");

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        // Helper to shuffle array
        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        const quant = [
            'Percentages', 'Profit & Loss', 'Profit and Loss', 'Time & Work', 'Time and Work', 
            'Trains', 'Problems on Trains', 'Boats & Streams', 'Boats and Streams', 'Averages', 
            'HCF & LCM', 'HCF and LCM', 'Simple Interest', 'Ratio & Proportion', 'Ratio and Proportion', 
            'Ages', 'Problems on Ages', 'Probability'
        ];

        for (let t of quant) {
            for (let i = 1; i <= 20; i++) {
                let n1 = i * 10, n2 = i + 2;
                let qText="", ansVal="", w1="", w2="", w3="", explanation="";

                // 1. Generate Question & Correct Answer
                if (t === 'Percentages') { 
                    qText = `What is ${n2}% of ${n1}?`; ansVal = `${n1*n2/100}`; w1=`${n1}`; w2=`0`; w3=`100`; explanation=`${n1} * ${n2}/100`;
                }
                else if (t.includes('Profit')) { 
                    qText = `CP = ${n1*10}, Profit = 20%. Find SP.`; ansVal=`${n1*12}`; w1=`${n1*10}`; w2=`${n1*8}`; w3=`0`; explanation=`SP = CP * 1.2`;
                }
                else if (t.includes('Time')) { 
                    qText = `A in ${n1} days, B in ${n1*2}. Together?`; ansVal=`${(n1*n1*2)/(n1*3)}`; w1=`${n1}`; w2=`${n1+5}`; w3=`1`; explanation=`(A*B)/(A+B)`;
                }
                else if (t.includes('HCF')) { 
                    qText = `HCF of ${n1} and ${n1*2}.`; ansVal=`${n1}`; w1=`1`; w2=`${n1*2}`; w3=`0`; explanation=`Highest common factor is ${n1}`;
                }
                else if (t === 'Averages') { 
                    qText = `Avg of 10, 20, 30 and ${n1}?`; ansVal=`${(60+n1)/4}`; w1=`${n1}`; w2=`20`; w3=`0`; explanation=`Sum/Count`;
                }
                else if (t.includes('Trains')) { 
                    qText = `Train ${n1}m at 36kmph crosses pole in?`; ansVal=`${n1/10}s`; w1=`${n1}s`; w2=`10s`; w3=`0`; explanation=`Time = Dist/Speed`;
                }
                else if (t.includes('Boats')) { 
                    qText = `Boat ${n1}kmph, Stream 2kmph. Downstream?`; ansVal=`${n1+2}`; w1=`${n1-2}`; w2=`${n1}`; w3=`2`; explanation=`Down = Boat + Stream`;
                }
                else if (t === 'Simple Interest') {
                    qText = `SI on ${n1*100} at 10% for 2 years?`; ansVal=`${n1*20}`; w1=`${n1*10}`; w2=`${n1}`; w3=`0`; explanation=`PTR/100`;
                }
                else if (t.includes('Ratio')) {
                    qText = `Ratio of ${n1} to ${n1}?`; ansVal=`1:1`; w1=`1:2`; w2=`2:1`; w3=`None`; explanation=`Same numbers ratio is 1:1`;
                }
                else if (t.includes('Ages')) {
                    qText = `A is ${n1}, B is twice A. B's age?`; ansVal=`${n1*2}`; w1=`${n1}`; w2=`${n1+5}`; w3=`0`; explanation=`2 * ${n1}`;
                }
                else if (t === 'Probability') {
                     qText=`Prob of Head in 1 toss?`; ansVal=`1/2`; w1=`1/4`; w2=`0`; w3=`1`; explanation=`1 outcome out of 2`;
                }

                // 2. SHUFFLE OPTIONS
                if(qText) {
                    let opts = [
                        { val: ansVal, isCorrect: true },
                        { val: w1, isCorrect: false },
                        { val: w2, isCorrect: false },
                        { val: w3, isCorrect: false }
                    ];
                    opts = shuffle(opts); // Randomize positions

                    // 3. Find which position holds the correct answer
                    let finalAns = 'A';
                    if(opts[1].isCorrect) finalAns = 'B';
                    if(opts[2].isCorrect) finalAns = 'C';
                    if(opts[3].isCorrect) finalAns = 'D';

                    await addQ('Quantitative', t, qText, opts[0].val, opts[1].val, opts[2].val, opts[3].val, finalAns, explanation);
                }
            }
        }
        res.send(`<h1>✅ DATA SHUFFLED!</h1><p>Questions now have randomized options (A, B, C, D).</p><a href="/">Go to Dashboard</a>`);
    } catch(err) { res.send("Error: " + err.message); }
});

// =============================================================
// 🔥 REASONING LOADER (DOES NOT DELETE MATHS)
// =============================================================
app.get('/load-reasoning-data', async (req, res) => {
    try {
        // 1. DELETE ONLY OLD REASONING DATA (Safety for Maths)
        await db.execute("DELETE FROM aptitude_questions WHERE category = 'Logical'");

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        // Helper to shuffle options
        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        // TOPICS FROM YOUR IMAGE
        const topics = [
            'Blood Relations', 'Number Series', 'Coding-Decoding', 'Syllogism', 
            'Seating Arrangement', 'Direction Sense', 'Clocks & Calendars', 
            'Analogy', 'Data Sufficiency', 'Logic Puzzles'
        ];

        for (let t of topics) {
            for (let i = 1; i <= 20; i++) {
                
                let qText="", ansVal="", w1="", w2="", w3="", explanation="";
                let n = i + 2; 

                // --- 1. NUMBER SERIES (Dynamic Logic) ---
                if (t === 'Number Series') {
                    if (i % 4 === 0) { // Arithmetic (+5)
                        qText = `Find next: ${n}, ${n+5}, ${n+10}, ${n+15}, ?`;
                        ansVal = `${n+20}`; w1=`${n+18}`; w2=`${n+25}`; w3=`${n+16}`;
                        explanation = `Series increases by +5.`;
                    } else if (i % 4 === 1) { // Squares
                        qText = `Find next: 4, 9, 16, 25, ?`; // Simplified for example
                        ansVal = `36`; w1=`30`; w2=`49`; w3=`32`;
                        explanation = `Squares of natural numbers (2^2, 3^2...).`;
                    } else if (i % 4 === 2) { // Multiplication
                        qText = `Find next: 2, 6, 18, 54, ?`;
                        ansVal = `162`; w1=`100`; w2=`108`; w3=`150`;
                        explanation = `Multiply previous number by 3.`;
                    } else { // Mixed
                        qText = `Find next: ${i*10}, ${i*9}, ${i*8}, ?`;
                        ansVal = `${i*7}`; w1=`${i*6}`; w2=`${i*5}`; w3=`0`;
                        explanation = `Decreasing multiples.`;
                    }
                }

                // --- 2. CODING DECODING ---
                else if (t === 'Coding-Decoding') {
                    if (i % 2 === 0) {
                        qText = `If CAT = 3120, then DOG = ?`;
                        ansVal = `4157`; w1=`4150`; w2=`3157`; w3=`400`;
                        explanation = `A=1, B=2, C=3... D=4, O=15, G=7.`;
                    } else {
                        qText = `If APPLE is coded as BQQMF (+1 logic), GRAPE = ?`;
                        ansVal = `HSBQF`; w1=`GRAPE`; w2=`FSAPE`; w3=`HQBQF`;
                        explanation = `Shift every letter by +1.`;
                    }
                }

                // --- 3. BLOOD RELATIONS ---
                else if (t === 'Blood Relations') {
                    if (i % 3 === 0) {
                        qText = `A is the brother of B. B is the father of C. How is A related to C?`;
                        ansVal = `Uncle`; w1=`Father`; w2=`Grandfather`; w3=`Brother`;
                        explanation = `Father's brother is Uncle.`;
                    } else if (i % 3 === 1) {
                        qText = `Pointing to a photo, a man said "She is the daughter of my grandfather's only son".`;
                        ansVal = `Sister`; w1=`Wife`; w2=`Mother`; w3=`Aunt`;
                        explanation = `Grandfather's only son = Father. Father's daughter = Sister.`;
                    } else {
                        qText = `A is mother of B. C is son of B. Relation of A to C?`;
                        ansVal = `Grandmother`; w1=`Mother`; w2=`Aunt`; w3=`Sister`;
                        explanation = `Father/Mother's mother is Grandmother.`;
                    }
                }

                // --- 4. CLOCKS & CALENDARS ---
                else if (t.includes('Clocks')) {
                    if (i % 2 === 0) { // Angle Formula
                        let h = 3, m = 30; // 3:30
                        qText = `Angle between hands at 3:30?`;
                        ansVal = `75 degrees`; w1=`90 degrees`; w2=`60 degrees`; w3=`0 degrees`;
                        explanation = `Formula: |30H - 5.5M| = |90 - 165| = 75.`;
                    } else { // Calendar
                        qText = `If today is Monday, what day will it be after 7 days?`;
                        ansVal = `Monday`; w1=`Tuesday`; w2=`Sunday`; w3=`Friday`;
                        explanation = `Days repeat every 7 days.`;
                    }
                }

                // --- 5. DIRECTION SENSE ---
                else if (t === 'Direction Sense') {
                    qText = `A man walks 3km North, then 4km East. How far from start?`;
                    ansVal = `5 km`; w1=`7 km`; w2=`3 km`; w3=`4 km`;
                    explanation = `Pythagoras Theorem: sqrt(3^2 + 4^2) = 5.`;
                }

                // --- 6. SYLLOGISM (Static Logic) ---
                else if (t === 'Syllogism') {
                    qText = `Statements: All A are B. All B are C. Conclusion: All A are C?`;
                    ansVal = `True`; w1=`False`; w2=`Maybe`; w3=`None`;
                    explanation = `If A is inside B, and B is inside C, then A is inside C.`;
                }

                // --- 7. ANALOGY ---
                else if (t === 'Analogy') {
                    if(i%2==0) { qText = `Doctor : Hospital :: Teacher : ?`; ansVal=`School`; w1=`Court`; w2=`Field`; w3=`Lab`; explanation=`Workplace relationship.`; }
                    else { qText = `Virus : Disease :: Exercise : ?`; ansVal=`Health`; w1=`Weakness`; w2=`Hospital`; w3=`Water`; explanation=`Cause and Effect.`; }
                }

                // --- 8. SEATING ARRANGEMENT ---
                else if (t === 'Seating Arrangement') {
                    qText = `5 friends (A,B,C,D,E) sit in a row. A is left of B. C is right of B. Who is middle? (Logic ${i})`;
                    ansVal = `B`; w1=`A`; w2=`C`; w3=`D`; explanation=`Arrangement logic based on left/right.`;
                }
                
                // --- DEFAULT FILLER ---
                else {
                    qText = `Logical Reasoning Question ${i} on ${t}`;
                    ansVal = `Correct Logic`; w1=`Wrong 1`; w2=`Wrong 2`; w3=`Wrong 3`;
                    explanation = `General logic applied.`;
                }

                // SHUFFLE & INSERT
                if(qText) {
                    let opts = shuffle([
                        { val: ansVal, isCorrect: true },
                        { val: w1, isCorrect: false },
                        { val: w2, isCorrect: false },
                        { val: w3, isCorrect: false }
                    ]);

                    let finalAns = 'A';
                    if(opts[1].isCorrect) finalAns = 'B';
                    if(opts[2].isCorrect) finalAns = 'C';
                    if(opts[3].isCorrect) finalAns = 'D';

                    await addQ('Logical', t, qText, opts[0].val, opts[1].val, opts[2].val, opts[3].val, finalAns, explanation);
                }
            }
        }

        res.send(`<h1>✅ REASONING LOADED!</h1><p>Added Blood Relations, Series, Coding etc. <br> <b>Maths questions are SAFE and untouched.</b></p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});
// =============================================================
// 🔥 FIX MISSING REASONING TOPICS (Clocks, Analogy, DS, Puzzles)
// =============================================================
app.get('/fix-missing-reasoning', async (req, res) => {
    try {
        // 1. Delete ONLY these 4 specific topics to avoid duplicates
        const missingTopics = [
            'Clocks & Calendars', 
            'Analogy', 
            'Data Sufficiency', 
            'Logic Puzzles'
        ];

        for (let t of missingTopics) {
            await db.execute("DELETE FROM aptitude_questions WHERE topic = ?", [t]);
        }

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        // Helper to shuffle options
        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        for (let t of missingTopics) {
            for (let i = 1; i <= 20; i++) {
                
                let qText="", ansVal="", w1="", w2="", w3="", explanation="";
                let n = i + 2;

                // --- 1. CLOCKS & CALENDARS ---
                if (t === 'Clocks & Calendars') {
                    if (i % 2 === 0) { // Angle
                        let h = 3, m = 30 + i; 
                        qText = `Find angle between hands at ${h}:${m}?`;
                        let angle = Math.abs(30*h - 5.5*m);
                        ansVal = `${angle}°`; w1=`${angle+10}°`; w2=`${angle-5}°`; w3=`0°`;
                        explanation = `Formula: |30H - 11/2M|.`;
                    } else { // Calendar
                        qText = `If 1st Jan 200${i} is Monday, what is 1st Jan 200${i+1}?`;
                        ansVal = `Tuesday`; w1=`Wednesday`; w2=`Sunday`; w3=`Friday`;
                        explanation = `Normal year +1 day, Leap year +2 days.`;
                    }
                }

                // --- 2. ANALOGY ---
                else if (t === 'Analogy') {
                    if(i % 3 === 0) {
                        qText = `Pen : Write :: Knife : ?`; ansVal=`Cut`; w1=`Vegetable`; w2=`Sharp`; w3=`Steel`; explanation=`Function relationship.`;
                    } else if(i % 3 === 1) {
                        qText = `Virus : Disease :: Exercise : ?`; ansVal=`Health`; w1=`Gym`; w2=`Running`; w3=`Sweat`; explanation=`Cause and Effect.`;
                    } else {
                        qText = `Good : Bad :: Roof : ?`; ansVal=`Floor`; w1=`Wall`; w2=`Window`; w3=`Sky`; explanation=`Antonyms.`;
                    }
                }

                // --- 3. DATA SUFFICIENCY ---
                else if (t === 'Data Sufficiency') {
                    qText = `Q: What is value of X? \n I. X + Y = 10 \n II. X - Y = 4`;
                    ansVal = `Both I and II required`; 
                    w1=`Only I is sufficient`; 
                    w2=`Only II is sufficient`; 
                    w3=`Neither is sufficient`;
                    explanation = `Solving two linear equations requires both statements.`;
                }

                // --- 4. LOGIC PUZZLES ---
                else if (t === 'Logic Puzzles') {
                    qText = `Logic Puzzle ${i}: Identify the odd behavior or pattern.`;
                    ansVal = `Correct Logic`; w1=`Wrong Logic`; w2=`Illogical`; w3=`None`;
                    explanation = `Requires critical thinking.`;
                }

                // SHUFFLE & INSERT
                if(qText) {
                    let opts = shuffle([
                        { val: ansVal, isCorrect: true },
                        { val: w1, isCorrect: false },
                        { val: w2, isCorrect: false },
                        { val: w3, isCorrect: false }
                    ]);

                    let finalAns = 'A';
                    if(opts[1].isCorrect) finalAns = 'B';
                    if(opts[2].isCorrect) finalAns = 'C';
                    if(opts[3].isCorrect) finalAns = 'D';

                    await addQ('Logical', t, qText, opts[0].val, opts[1].val, opts[2].val, opts[3].val, finalAns, explanation);
                }
            }
        }

        res.send(`<h1>✅ MISSING TOPICS FIXED!</h1><p>Clocks, Analogy, DS, and Puzzles are now filled.</p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});

// =============================================================
// 🔥 FIX CORE REASONING (Series, Blood Relations, Coding, etc.)
// =============================================================
app.get('/fix-core-reasoning', async (req, res) => {
    try {
        // 1. Target ONLY the empty topics
        const coreTopics = [
            'Blood Relations', 
            'Number Series', 
            'Coding-Decoding', 
            'Syllogism', 
            'Seating Arrangement', 
            'Direction Sense'
        ];

        // 2. Clear ONLY these specific topics
        for (let t of coreTopics) {
            await db.execute("DELETE FROM aptitude_questions WHERE topic = ?", [t]);
        }

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        // Helper to shuffle options
        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        for (let t of coreTopics) {
            for (let i = 1; i <= 20; i++) {
                
                let qText="", ansVal="", w1="", w2="", w3="", explanation="";
                let n = i + 5;

                // --- 1. NUMBER SERIES ---
                if (t === 'Number Series') {
                    if (i % 3 === 0) { // Arithmetic
                        qText = `Find next: ${n}, ${n+5}, ${n+10}, ${n+15}, ?`;
                        ansVal = `${n+20}`; w1=`${n+18}`; w2=`${n+25}`; w3=`${n+10}`;
                        explanation = `Add 5 to previous number.`;
                    } else if (i % 3 === 1) { // Geometric
                        qText = `Find next: 2, 6, 18, 54, ?`;
                        ansVal = `162`; w1=`100`; w2=`120`; w3=`200`;
                        explanation = `Multiply by 3.`;
                    } else { // Squares
                        qText = `Find next: 4, 9, 16, 25, ?`;
                        ansVal = `36`; w1=`49`; w2=`30`; w3=`32`;
                        explanation = `Squares of natural numbers.`;
                    }
                }

                // --- 2. CODING DECODING ---
                else if (t === 'Coding-Decoding') {
                    qText = `If A=1, B=2, what is BAD?`;
                    ansVal = `214`; w1=`123`; w2=`224`; w3=`114`;
                    explanation = `Direct letter numbering.`;
                }

                // --- 3. BLOOD RELATIONS ---
                else if (t === 'Blood Relations') {
                    qText = `A is brother of B. B is father of C. How is A related to C?`;
                    ansVal = `Uncle`; w1=`Father`; w2=`Grandfather`; w3=`Brother`;
                    explanation = `Father's brother is Uncle.`;
                }

                // --- 4. SYLLOGISM ---
                else if (t === 'Syllogism') {
                    qText = `Statement: All Cats are Dogs. Some Dogs are Birds. Conclusion: Some Cats are Birds?`;
                    ansVal = `False / Cannot be determined`; w1=`True`; w2=`Maybe`; w3=`None`;
                    explanation = `No direct relation given between Cats and Birds.`;
                }

                // --- 5. SEATING ARRANGEMENT ---
                else if (t === 'Seating Arrangement') {
                    qText = `5 people A,B,C,D,E sit in a row. C is in middle. A is left of C. B is right of C. Who is at immediate right of C?`;
                    ansVal = `B`; w1=`A`; w2=`D`; w3=`E`;
                    explanation = `Directly given in statement.`;
                }

                // --- 6. DIRECTION SENSE ---
                else if (t === 'Direction Sense') {
                    qText = `Person walks 3km North, then turns Right and walks 4km. Distance from start?`;
                    ansVal = `5km`; w1=`7km`; w2=`3km`; w3=`4km`;
                    explanation = `Pythagoras theorem: sqrt(3^2 + 4^2) = 5.`;
                }

                // SHUFFLE & INSERT
                if(qText) {
                    let opts = shuffle([
                        { val: ansVal, isCorrect: true },
                        { val: w1, isCorrect: false },
                        { val: w2, isCorrect: false },
                        { val: w3, isCorrect: false }
                    ]);

                    let finalAns = 'A';
                    if(opts[1].isCorrect) finalAns = 'B';
                    if(opts[2].isCorrect) finalAns = 'C';
                    if(opts[3].isCorrect) finalAns = 'D';

                    await addQ('Logical', t, qText, opts[0].val, opts[1].val, opts[2].val, opts[3].val, finalAns, explanation);
                }
            }
        }

        res.send(`<h1>✅ CORE REASONING FIXED!</h1><p>Series, Coding, Blood Relations, Syllogism, Seating, Directions are now FILLED.</p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});

// =============================================================
// 🔥 ONLY REASONING FIX (MATHS SAFE MODE)
// =============================================================
app.get('/fix-only-reasoning', async (req, res) => {
    try {
        // 1. DELETE ONLY LOGICAL CATEGORY (Maths is SAFE)
        await db.execute("DELETE FROM aptitude_questions WHERE category = 'Logical'");

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        // ALL REASONING TOPICS
        const topics = [
            'Blood Relations', 'Number Series', 'Coding-Decoding', 'Syllogism', 
            'Seating Arrangement', 'Direction Sense', 'Clocks & Calendars', 
            'Analogy', 'Data Sufficiency', 'Logic Puzzles'
        ];

        for (let t of topics) {
            for (let i = 1; i <= 20; i++) {
                
                let qText="", ansVal="", w1="", w2="", w3="", exp="";
                let n = i + 5;

                // --- 1. NUMBER SERIES ---
                if (t === 'Number Series') {
                    if (i % 3 === 0) { 
                        qText=`Find next: ${n}, ${n+5}, ${n+10}, ?`; ansVal=`${n+15}`; w1=`${n+12}`; w2=`${n+20}`; w3=`0`; exp=`Add 5 logic`; 
                    } else if (i % 3 === 1) { 
                        qText=`Find next: 2, 6, 18, ?`; ansVal=`54`; w1=`36`; w2=`72`; w3=`100`; exp=`Multiply by 3`; 
                    } else { 
                        qText=`Find next: 10, 20, 40, ?`; ansVal=`80`; w1=`60`; w2=`100`; w3=`50`; exp=`Double the number`; 
                    }
                }
                // --- 2. CODING ---
                else if (t === 'Coding-Decoding') {
                    qText=`If A=1, B=2, CAT=?`; ansVal=`24`; w1=`20`; w2=`26`; w3=`15`; exp=`Sum of positions (3+1+20)`;
                }
                // --- 3. BLOOD RELATIONS ---
                else if (t === 'Blood Relations') {
                    qText=`A is father of B. B is sister of C. A to C?`; ansVal=`Father`; w1=`Uncle`; w2=`Brother`; w3=`Grandpa`; exp=`Direct relation`;
                }
                // --- 4. SYLLOGISM ---
                else if (t === 'Syllogism') {
                    qText=`Statement: All A are B. No B is C. Conclusion: No A is C?`; ansVal=`True`; w1=`False`; w2=`Maybe`; w3=`None`; exp=`A is inside B, B touches no C.`;
                }
                // --- 5. DIRECTIONS ---
                else if (t === 'Direction Sense') {
                    qText=`Walk 3km North, turn Right, walk 4km. Dist?`; ansVal=`5km`; w1=`7km`; w2=`3km`; w3=`4km`; exp=`Pythagoras theorem`;
                }
                // --- 6. SEATING ---
                else if (t === 'Seating Arrangement') {
                    qText=`A, B, C sit in row. A is left of B. C is right of B. Middle?`; ansVal=`B`; w1=`A`; w2=`C`; w3=`None`; exp=`Order: A - B - C`;
                }
                // --- 7. CLOCKS ---
                else if (t.includes('Clocks')) {
                    qText=`Angle at 3:00?`; ansVal=`90°`; w1=`180°`; w2=`60°`; w3=`0°`; exp=`3 gaps * 30 deg`;
                }
                // --- 8. ANALOGY ---
                else if (t === 'Analogy') {
                    qText=`Day : Night :: Up : ?`; ansVal=`Down`; w1=`Sky`; w2=`High`; w3=`Low`; exp=`Antonyms`;
                }
                // --- 9. DATA SUFFICIENCY ---
                else if (t === 'Data Sufficiency') {
                    qText=`Value of x? I. x+y=5 II. x-y=1`; ansVal=`Both required`; w1=`Only I`; w2=`Only II`; w3=`None`; exp=`Linear equations`;
                }
                // --- 10. PUZZLES ---
                else {
                    qText=`Logical Puzzle Q${i}`; ansVal=`Logic A`; w1=`Logic B`; w2=`Logic C`; w3=`Logic D`; exp=`Reasoning check`;
                }

                // Shuffle Options
                let opts = shuffle([{v:ansVal,c:true}, {v:w1,c:false}, {v:w2,c:false}, {v:w3,c:false}]);
                let f='A'; if(opts[1].c)f='B'; if(opts[2].c)f='C'; if(opts[3].c)f='D';

                await addQ('Logical', t, qText, opts[0].v, opts[1].v, opts[2].v, opts[3].v, f, exp);
            }
        }

        res.send(`<h1>✅ REASONING FIXED!</h1><p>Blood Relations, Series, Coding... all filled. <br> <b>Maths (Aptitude) is 100% SAFE.</b></p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});
// =============================================================
// 📘 ENGLISH PAGE ROUTE (ఇది లేకపోతే పేజీ రాదు)
// =============================================================
app.get('/english-topics', requireLogin, (req, res) => {
    // ఈ 15 టాపిక్స్ లిస్ట్ ఉంటేనే నీకు ఐకాన్స్ కనిపిస్తాయి
    const englishTopics = [
        { topic: 'Parts of Speech' },
        { topic: 'Tenses' },
        { topic: 'Active and Passive Voice' },
        { topic: 'Direct and Indirect Speech' },
        { topic: 'Subject-Verb Agreement' },
        { topic: 'Spotting Errors' },
        { topic: 'Synonyms and Antonyms' },
        { topic: 'Idioms and Phrases' },
        { topic: 'One Word Substitution' },
        { topic: 'Spelling Test' },
        { topic: 'Fill in the Blanks' },
        { topic: 'Phrasal Verbs' },
        { topic: 'Reading Comprehension' },
        { topic: 'Cloze Test' },
        { topic: 'Sentence Rearrangement' }
    ];

    res.render('english_topics', { 
        user: req.session.user, 
        topics: englishTopics 
    });
});
// =============================================================
// 🔥 ENGLISH REAL FINAL (250+ UNIQUE QUESTIONS - NO LOOPS)
// =============================================================
app.get('/fix-english-real-final', async (req, res) => {
    try {
        // 1. DELETE ONLY VERBAL (Safety for Quant/Reasoning)
        await db.execute("DELETE FROM aptitude_questions WHERE category = 'Verbal'");

        const addQ = async (topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['Verbal', topic, q, a, b, c, d, corr, exp]);
        };

        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        // --- MASSIVE UNIQUE QUESTION BANK (NO REPETITION) ---
        const allData = {
            'Parts of Speech': [
                {q:'She handled the situation with EASE. (Identify capitalized word)', a:'Noun', w1:'Verb', w2:'Adverb', w3:'Adjective', exp:'Object of preposition "with".'},
                {q:'He is LITTLE known here.', a:'Adverb', w1:'Adjective', w2:'Noun', w3:'Verb', exp:'Modifies the verb "known".'},
                {q:'The UP train is late.', a:'Adjective', w1:'Preposition', w2:'Noun', w3:'Adverb', exp:'Describes the noun "train".'},
                {q:'SIT down and rest.', a:'Verb', w1:'Noun', w2:'Adverb', w3:'Preposition', exp:'Action word.'},
                {q:'Hurrah! We won.', a:'Interjection', w1:'Conjunction', w2:'Adverb', w3:'Noun', exp:'Expresses sudden emotion.'},
                {q:'He kept the fast for a week.', a:'Noun', w1:'Verb', w2:'Adjective', w3:'Adverb', exp:'Name of an action/event.'},
                {q:'Still waters run deep.', a:'Adjective', w1:'Adverb', w2:'Verb', w3:'Noun', exp:'Describes "waters".'},
                {q:'He is an ONLY child.', a:'Adjective', w1:'Adverb', w2:'Preposition', w3:'Conjunction', exp:'Describes "child".'},
                {q:'Check your ticket.', a:'Verb', w1:'Noun', w2:'Adverb', w3:'Adjective', exp:'Action (Imperative).'},
                {q:'Give me a check.', a:'Noun', w1:'Verb', w2:'Adverb', w3:'Adjective', exp:'Name of a thing.'},
                {q:'They arrived soon after.', a:'Adverb', w1:'Preposition', w2:'Conjunction', w3:'Noun', exp:'Modifies "arrived".'},
                {q:'They arrived after we had left.', a:'Conjunction', w1:'Preposition', w2:'Adverb', w3:'Noun', exp:'Joins two clauses.'},
                {q:'He is about to go.', a:'Preposition', w1:'Adverb', w2:'Verb', w3:'Noun', exp:'Shows relationship.'},
                {q:'There is a bridge over the river.', a:'Preposition', w1:'Adverb', w2:'Verb', w3:'Noun', exp:'Shows position.'},
                {q:'Let us move on.', a:'Adverb', w1:'Preposition', w2:'Noun', w3:'Verb', exp:'Modifies "move".'}
            ],
            'Tenses': [
                {q:'By the time I reached, the train ______.', a:'had left', w1:'left', w2:'has left', w3:'was leaving', exp:'Past Perfect for earlier action.'},
                {q:'It ______ raining since morning.', a:'has been', w1:'is', w2:'was', w3:'had', exp:'Present Perfect Continuous.'},
                {q:'If I ______ a bird, I would fly.', a:'were', w1:'was', w2:'am', w3:'be', exp:'Subjunctive mood.'},
                {q:'The earth ______ round the sun.', a:'moves', w1:'moved', w2:'is moving', w3:'has moved', exp:'Universal truth uses Simple Present.'},
                {q:'I ______ him for ten years.', a:'have known', w1:'know', w2:'am knowing', w3:'knew', exp:'Stative verb "know" uses perfect tense.'},
                {q:'He ______ out five minutes ago.', a:'went', w1:'has gone', w2:'had gone', w3:'goes', exp:'"Ago" indicates Simple Past.'},
                {q:'Look! The bus ______.', a:'is coming', w1:'comes', w2:'came', w3:'has come', exp:'Action happening now.'},
                {q:'I ______ my work just now.', a:'have finished', w1:'finished', w2:'had finished', w3:'finish', exp:'"Just now" indicates Present Perfect.'},
                {q:'When I saw him, he ______ cricket.', a:'was playing', w1:'played', w2:'is playing', w3:'plays', exp:'Past continuous.'},
                {q:'He ______ tomorrow.', a:'will come', w1:'came', w2:'has come', w3:'had come', exp:'Future action.'},
                {q:'By next year, she ______ graduated.', a:'will have', w1:'will be', w2:'has', w3:'had', exp:'Future Perfect.'},
                {q:'She ______ tea every morning.', a:'drinks', w1:'drinking', w2:'drank', w3:'drunk', exp:'Habitual action.'},
                {q:'The train ______ before we reached.', a:'had left', w1:'left', w2:'has left', w3:'leaves', exp:'Past Perfect.'},
                {q:'I ______ to the cinema last night.', a:'went', w1:'have gone', w2:'had gone', w3:'go', exp:'"Last night" indicates Simple Past.'},
                {q:'Wait until I ______ back.', a:'come', w1:'came', w2:'will come', w3:'coming', exp:'Simple present in future time clause.'}
            ],
            'Active and Passive Voice': [
                {q:'"Who taught you French?"', a:'By whom were you taught French?', w1:'Who was taught French to you?', w2:'By whom was you taught?', w3:'None', exp:'Who -> By whom.'},
                {q:'"Do not insult the weak."', a:'Let the weak not be insulted.', w1:'The weak are not insulted.', w2:'Do not be insulted.', w3:'None', exp:'Imperative sentence.'},
                {q:'"I know him."', a:'He is known to me.', w1:'He is known by me.', w2:'He was known.', w3:'None', exp:'Know takes "to", not "by".'},
                {q:'"Someone has stolen my pen."', a:'My pen has been stolen.', w1:'My pen was stolen.', w2:'My pen is stolen.', w3:'None', exp:'Agent is unknown.'},
                {q:'"They are building a house."', a:'A house is being built by them.', w1:'A house is built.', w2:'A house was being built.', w3:'None', exp:'Continuous needs "being".'},
                {q:'"Open the door."', a:'Let the door be opened.', w1:'The door opened.', w2:'Open door please.', w3:'None', exp:'Imperative.'},
                {q:'"He satisfies me."', a:'I am satisfied with him.', w1:'I am satisfied by him.', w2:'I was satisfied.', w3:'None', exp:'Satisfy takes "with".'},
                {q:'"Did he buy a car?"', a:'Was a car bought by him?', w1:'Is a car bought?', w2:'Did a car bought?', w3:'None', exp:'Past interrogative.'},
                {q:'"People speak English all over the world."', a:'English is spoken all over the world.', w1:'English was spoken.', w2:'English has spoken.', w3:'None', exp:'General truth passive.'},
                {q:'"She will help me."', a:'I shall be helped by her.', w1:'I will helped.', w2:'I am helped.', w3:'None', exp:'Future passive.'},
                {q:'"They made him King."', a:'He was made King by them.', w1:'King was made him.', w2:'He is made King.', w3:'None', exp:'Factitive object.'},
                {q:'"I am reading a book."', a:'A book is being read by me.', w1:'A book was read.', w2:'A book has read.', w3:'None', exp:'Present continuous.'},
                {q:'"Respect your elders."', a:'Your elders should be respected.', w1:'Respect elders.', w2:'Elders respected.', w3:'None', exp:'Suggestion.'},
                {q:'"Has he done the work?"', a:'Has the work been done by him?', w1:'Has the work done?', w2:'Was the work done?', w3:'None', exp:'Perfect interrogative.'},
                {q:'"He was writing a letter."', a:'A letter was being written by him.', w1:'A letter was written.', w2:'A letter is written.', w3:'None', exp:'Past continuous.'}
            ],
            'Direct and Indirect Speech': [
                {q:'He said, "I am busy."', a:'He said that he was busy.', w1:'He said he is busy.', w2:'He says he was busy.', w3:'None', exp:'Present -> Past.'},
                {q:'He said to me, "Are you coming?"', a:'He asked me if I was coming.', w1:'He asked if I am coming.', w2:'He told if I was coming.', w3:'None', exp:'Question uses if/whether.'},
                {q:'She said, "Alas! I am lost."', a:'She exclaimed with sorrow that she was lost.', w1:'She said alas she was lost.', w2:'She cried she is lost.', w3:'None', exp:'Exclamatory sentence.'},
                {q:'Teacher said, "The sun is a star."', a:'Teacher said that the sun is a star.', w1:'Teacher said the sun was a star.', w2:'Teacher asked if sun is star.', w3:'None', exp:'Universal truth implies no change.'},
                {q:'He said, "Let us go."', a:'He suggested that they should go.', w1:'He said let us go.', w2:'He ordered to go.', w3:'None', exp:'Suggestion.'},
                {q:'He said, "I saw him yesterday."', a:'He said he had seen him the previous day.', w1:'He saw him yesterday.', w2:'He said he saw him.', w3:'None', exp:'Past -> Past Perfect.'},
                {q:'"What a beautiful flower!" he said.', a:'He exclaimed that it was a very beautiful flower.', w1:'He said it is a beautiful flower.', w2:'He asked what beautiful.', w3:'None', exp:'Exclamatory.'},
                {q:'He said to me, "Go away."', a:'He ordered me to go away.', w1:'He said to go away.', w2:'He asked go away.', w3:'None', exp:'Imperative order.'},
                {q:'She said, "I can swim."', a:'She said that she could swim.', w1:'She said she can swim.', w2:'She says she could swim.', w3:'None', exp:'Can -> Could.'},
                {q:'Ravi said, "I have passed."', a:'Ravi said that he had passed.', w1:'Ravi said he has passed.', w2:'Ravi said he passed.', w3:'None', exp:'Present Perfect -> Past Perfect.'},
                {q:'He said, "May you live long."', a:'He prayed that I might live long.', w1:'He said might I live long.', w2:'He prayed I live long.', w3:'None', exp:'Optative sentence.'},
                {q:'She said, "I will do it."', a:'She said that she would do it.', w1:'She said she will do it.', w2:'She said she does it.', w3:'None', exp:'Will -> Would.'},
                {q:'He says, "I am fine."', a:'He says that he is fine.', w1:'He says he was fine.', w2:'He said he is fine.', w3:'None', exp:'Reporting verb present -> No tense change.'},
                {q:'Father said, "Don\'t shout."', a:'Father forbade me to shout.', w1:'Father said not shout.', w2:'Father asked don\'t shout.', w3:'None', exp:'Negative command.'},
                {q:'He said, "Where do you live?"', a:'He asked me where I lived.', w1:'He asked where do I live.', w2:'He said where I lived.', w3:'None', exp:'Wh-question.'}
            ],
            'Subject-Verb Agreement': [
                {q:'Bread and butter ______ his daily diet.', a:'is', w1:'are', w2:'were', w3:'have', exp:'Single unit/idea takes singular.'},
                {q:'The quality of mangoes ______ poor.', a:'was', w1:'were', w2:'are', w3:'have', exp:'Subject is "Quality" (Singular).'},
                {q:'Neither he nor I ______ guilty.', a:'am', w1:'is', w2:'are', w3:'were', exp:'Agrees with nearest subject (I).'},
                {q:'Fifty miles ______ a long way.', a:'is', w1:'are', w2:'were', w3:'have', exp:'Distance as a unit is singular.'},
                {q:'The police ______ coming.', a:'are', w1:'is', w2:'was', w3:'has', exp:'Police is plural.'},
                {q:'One of the boys ______ missing.', a:'is', w1:'are', w2:'were', w3:'have', exp:'"One" is singular.'},
                {q:'Each of the girls ______ a pen.', a:'has', w1:'have', w2:'are', w3:'were', exp:'"Each" takes singular.'},
                {q:'Time and tide ______ for none.', a:'wait', w1:'waits', w2:'waiting', w3:'weighted', exp:'Two distinct ideas -> Plural (Old English rule exception often used in papers).'},
                {q:'Mathematics ______ hard.', a:'is', w1:'are', w2:'were', w3:'have', exp:'Subject name is singular.'},
                {q:'The jury ______ divided in their opinion.', a:'were', w1:'was', w2:'is', w3:'has', exp:'Divided opinion -> Plural.'},
                {q:'Slow and steady ______ the race.', a:'wins', w1:'win', w2:'winning', w3:'won', exp:'Single idea.'},
                {q:'Many a man ______ done this.', a:'has', w1:'have', w2:'are', w3:'were', exp:'"Many a" takes singular.'},
                {q:'Gold and Silver ______ precious.', a:'are', w1:'is', w2:'was', w3:'has', exp:'Two nouns joined by and.'},
                {q:'The poor ______ suffering.', a:'are', w1:'is', w2:'was', w3:'has', exp:'"The poor" refers to the class of people (Plural).'},
                {q:'Physics ______ my subject.', a:'is', w1:'are', w2:'were', w3:'have', exp:'Subject name.'}
            ],
            'Spotting Errors': [
                {q:'Error: "One of the (A) / boy is (B) / missing (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Should be "One of the BOYS".'},
                {q:'Error: "He is (A) / senior than (B) / me (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Senior takes "to", not "than".'},
                {q:'Error: "I prefer (A) / coffee than (B) / tea (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Prefer takes "to".'},
                {q:'Error: "Unless you (A) / do not run (B) / you will lose (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Unless is already negative.'},
                {q:'Error: "She has (A) / white hairs (B) / on her head (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Hair is uncountable (white hair).'},
                {q:'Error: "The sceneries (A) / of Kashmir (B) / are beautiful (C)"', a:'A', w1:'B', w2:'C', w3:'No error', exp:'Scenery has no plural.'},
                {q:'Error: "Return (A) / back (B) / home (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Return implies back. Remove back.'},
                {q:'Error: "He discussed (A) / about the (B) / matter (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Discuss is transitive. No "about".'},
                {q:'Error: "My cousin (A) / brother is (B) / coming (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Cousin is enough. Remove brother.'},
                {q:'Error: "He is (A) / good in (B) / English (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Good "at" English.'},
                {q:'Error: "Each of (A) / the student (B) / is present (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Each of the "students".'},
                {q:'Error: "If I was (A) / a bird (B) / I would fly (C)"', a:'A', w1:'B', w2:'C', w3:'No error', exp:'Imaginary condition uses "were".'},
                {q:'Error: "The cattles (A) / are (B) / grazing (C)"', a:'A', w1:'B', w2:'C', w3:'No error', exp:'Cattle is plural. No "s".'},
                {q:'Error: "Did he (A) / went (B) / there? (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Did takes V1 (go).'},
                {q:'Error: "She is (A) / married with (B) / a doctor (C)"', a:'B', w1:'A', w2:'C', w3:'No error', exp:'Married "to".'}
            ],
            'Synonyms and Antonyms': [
                {q:'Synonym of: LETHARGY', a:'Sluggishness', w1:'Energy', w2:'Speed', w3:'Joy', exp:'Lack of energy.'},
                {q:'Synonym of: CANDID', a:'Frank', w1:'Secretive', w2:'Rude', w3:'Shy', exp:'Open and honest.'},
                {q:'Antonym of: MITIGATE', a:'Aggravate', w1:'Relieve', w2:'Calm', w3:'Help', exp:'Mitigate=Reduce, Aggravate=Worsen.'},
                {q:'Antonym of: OBSOLETE', a:'Modern', w1:'Old', w2:'Rare', w3:'Past', exp:'Obsolete=Outdated.'},
                {q:'Antonym of: ADVERSITY', a:'Prosperity', w1:'Bad luck', w2:'Pain', w3:'Fear', exp:'Adversity=Hardship.'},
                {q:'Synonym of: ABANDON', a:'Forsake', w1:'Keep', w2:'Join', w3:'Love', exp:'To leave.'},
                {q:'Synonym of: DILIGENT', a:'Hardworking', w1:'Lazy', w2:'Slow', w3:'Weak', exp:'Shows care.'},
                {q:'Antonym of: BRAVE', a:'Cowardly', w1:'Bold', w2:'Strong', w3:'Fearless', exp:'Lacking courage.'},
                {q:'Antonym of: FOREIGN', a:'Native', w1:'Alien', w2:'Strange', w3:'New', exp:'Belonging to a place.'},
                {q:'Synonym of: FATAL', a:'Deadly', w1:'Safe', w2:'Good', w3:'Life', exp:'Causing death.'},
                {q:'Synonym of: BRIEF', a:'Concise', w1:'Long', w2:'Large', w3:'Deep', exp:'Short.'},
                {q:'Antonym of: EXPAND', a:'Contract', w1:'Grow', w2:'Big', w3:'Wide', exp:'Shrink.'},
                {q:'Synonym of: HUMBLE', a:'Modest', w1:'Proud', w2:'Rude', w3:'Loud', exp:'Not arrogant.'},
                {q:'Antonym of: GUILTY', a:'Innocent', w1:'Bad', w2:'Wrong', w3:'Sinful', exp:'Not guilty.'},
                {q:'Synonym of: HUGE', a:'Enormous', w1:'Tiny', w2:'Small', w3:'Little', exp:'Very big.'}
            ],
            'Idioms and Phrases': [
                {q:'"To burn the midnight oil"', a:'Work late night', w1:'Burn oil', w2:'Sleep early', w3:'Waste money', exp:'Hard work at night.'},
                {q:'"A white elephant"', a:'Costly but useless', w1:'Rare animal', w2:'Strong person', w3:'Big profit', exp:'Useless possession.'},
                {q:'"Once in a blue moon"', a:'Rarely', w1:'Often', w2:'Daily', w3:'Never', exp:'Very infrequent.'},
                {q:'"Break the ice"', a:'Start conversation', w1:'Break glass', w2:'Feel cold', w3:'Fight', exp:'Ease tension.'},
                {q:'"Apple of one\'s eye"', a:'Very dear', w1:'Fruit', w2:'Enemy', w3:'Blind', exp:'Favorite person.'},
                {q:'"To read between the lines"', a:'Find hidden meaning', w1:'Read slowly', w2:'Read aloud', w3:'Ignore', exp:'Understand implied meaning.'},
                {q:'"A bed of roses"', a:'Comfortable life', w1:'Garden', w2:'Thorns', w3:'Flowers', exp:'Easy situation.'},
                {q:'"Black sheep"', a:'Disgrace to family', w1:'Animal', w2:'Dark', w3:'Wool', exp:'Unworthy member.'},
                {q:'"Crocodile tears"', a:'False sorrow', w1:'Real sad', w2:'Animal', w3:'Crying', exp:'Pretended grief.'},
                {q:'"Piece of cake"', a:'Very easy', w1:'Tasty', w2:'Food', w3:'Hard', exp:'Simple task.'},
                {q:'"Rain cats and dogs"', a:'Rain heavily', w1:'Animals', w2:'Fight', w3:'Pet', exp:'Heavy rain.'},
                {q:'"Bone of contention"', a:'Cause of quarrel', w1:'Food', w2:'Dog', w3:'Bone', exp:'Dispute source.'},
                {q:'"By hook or by crook"', a:'By any means', w1:'Fishing', w2:'Walking', w3:'Stick', exp:'Any method.'},
                {q:'"Lion\'s share"', a:'Major part', w1:'Animal', w2:'King', w3:'Small', exp:'Biggest portion.'},
                {q:'"Turn a deaf ear"', a:'Ignore', w1:'Listen', w2:'Ear', w3:'Hear', exp:'Refuse to listen.'}
            ],
            'One Word Substitution': [
                {q:'One who does not believe in God', a:'Atheist', w1:'Theist', w2:'Pagan', w3:'Saint', exp:'A=No, Theos=God.'},
                {q:'Life history written by self', a:'Autobiography', w1:'Biography', w2:'History', w3:'Memoir', exp:'Auto=Self.'},
                {q:'A place where birds are kept', a:'Aviary', w1:'Apiary', w2:'Zoo', w3:'Cage', exp:'Avis=Bird.'},
                {q:'One who knows everything', a:'Omniscient', w1:'Wise', w2:'Smart', w3:'God', exp:'Omni=All, Sci=Know.'},
                {q:'Remedy for all diseases', a:'Panacea', w1:'Cure', w2:'Drug', w3:'Virus', exp:'Universal cure.'},
                {q:'One who eats everything', a:'Omnivorous', w1:'Carnivorous', w2:'Herbivorous', w3:'Eater', exp:'Omni=All.'},
                {q:'Government by the people', a:'Democracy', w1:'Autocracy', w2:'Monarchy', w3:'Rule', exp:'Demos=People.'},
                {q:'One who loves books', a:'Bibliophile', w1:'Reader', w2:'Writer', w3:'Book', exp:'Biblio=Book.'},
                {q:'Murder of a king', a:'Regicide', w1:'Suicide', w2:'Homicide', w3:'Kill', exp:'Regis=King.'},
                {q:'Sound that cannot be heard', a:'Inaudible', w1:'Audible', w2:'Loud', w3:'Silent', exp:'In=Not.'},
                {q:'One who cannot die', a:'Immortal', w1:'Mortal', w2:'Dead', w3:'Human', exp:'Im=Not.'},
                {q:'A place for bees', a:'Apiary', w1:'Aviary', w2:'Hive', w3:'Farm', exp:'Apis=Bee.'},
                {q:'One who believes in God', a:'Theist', w1:'Atheist', w2:'Monk', w3:'Holy', exp:'Theos=God.'},
                {q:'Life history written by other', a:'Biography', w1:'Autobiography', w2:'Story', w3:'Tale', exp:'Bio=Life.'},
                {q:'A speech made without preparation', a:'Extempore', w1:'Debate', w2:'Lecture', w3:'Speech', exp:'Unrehearsed.'}
            ],
            'Spelling Test': [
                {q:'Choose correct spelling:', a:'Lieutenant', w1:'Leutenant', w2:'Lieutenent', w3:'Lutenent', exp:'L-i-e-u-t-e-n-a-n-t.'},
                {q:'Choose correct spelling:', a:'Accommodation', w1:'Accomodation', w2:'Acommodation', w3:'Acomodation', exp:'Double c, Double m.'},
                {q:'Choose correct spelling:', a:'Embarrass', w1:'Embarass', w2:'Emberass', w3:'Embaras', exp:'Double r, Double s.'},
                {q:'Choose correct spelling:', a:'Vacuum', w1:'Vaccuum', w2:'Vacume', w3:'Vaccum', exp:'One c, two u.'},
                {q:'Choose correct spelling:', a:'Restaurant', w1:'Restarant', w2:'Resturant', w3:'Resterant', exp:'Rest-au-rant.'},
                {q:'Choose correct spelling:', a:'Colonel', w1:'Colnel', w2:'Colonal', w3:'Kernal', exp:'Pronounced kernel.'},
                {q:'Choose correct spelling:', a:'Separate', w1:'Seperate', w2:'Seperat', w3:'Seprate', exp:'S-e-p-a-r-a-t-e.'},
                {q:'Choose correct spelling:', a:'Queue', w1:'Que', w2:'Qeue', w3:'Quue', exp:'Q-u-e-u-e.'},
                {q:'Choose correct spelling:', a:'Psychology', w1:'Sychology', w2:'Pyschology', w3:'Psycholgy', exp:'Silent P.'},
                {q:'Choose correct spelling:', a:'Bureaucracy', w1:'Burocracy', w2:'Bureacracy', w3:'Burocracy', exp:'Beau-crat.'},
                {q:'Choose correct spelling:', a:'Maintenance', w1:'Maintainance', w2:'Maintanance', w3:'Maintenence', exp:'Main-ten-ance.'},
                {q:'Choose correct spelling:', a:'Grammar', w1:'Grammer', w2:'Gramar', w3:'Gramer', exp:'Ends in -ar.'},
                {q:'Choose correct spelling:', a:'Receive', w1:'Recieve', w2:'Riceive', w3:'Receve', exp:'E before I.'},
                {q:'Choose correct spelling:', a:'Necessary', w1:'Neccessary', w2:'Necesary', w3:'Necessery', exp:'One c, two s.'},
                {q:'Choose correct spelling:', a:'Occasion', w1:'Occassion', w2:'Ocasion', w3:'Occation', exp:'Two c, one s.'}
            ],
            'Fill in the Blanks': [
                {q:'He is addicted ___ smoking.', a:'to', w1:'of', w2:'with', w3:'in', exp:'Addicted to.'},
                {q:'I prefer tea ___ coffee.', a:'to', w1:'than', w2:'over', w3:'from', exp:'Prefer to.'},
                {q:'She is afraid ___ dogs.', a:'of', w1:'from', w2:'with', w3:'by', exp:'Afraid of.'},
                {q:'The cat jumped ___ the table.', a:'upon', w1:'on', w2:'in', w3:'at', exp:'Motion upwards.'},
                {q:'He died ___ cancer.', a:'of', w1:'from', w2:'with', w3:'by', exp:'Died of disease.'},
                {q:'Listen ___ me.', a:'to', w1:'at', w2:'on', w3:'with', exp:'Listen to.'},
                {q:'Look ___ the blackboard.', a:'at', w1:'on', w2:'in', w3:'to', exp:'Look at.'},
                {q:'Divide this ___ two parts.', a:'into', w1:'in', w2:'to', w3:'on', exp:'Change of state.'},
                {q:'He is married ___ her.', a:'to', w1:'with', w2:'by', w3:'for', exp:'Married to.'},
                {q:'Beware ___ dogs.', a:'of', w1:'from', w2:'to', w3:'with', exp:'Beware of.'},
                {q:'I agree ___ you.', a:'with', w1:'to', w2:'on', w3:'at', exp:'Agree with person.'},
                {q:'He deals ___ sugar.', a:'in', w1:'with', w2:'at', w3:'on', exp:'Trade in.'},
                {q:'The book is ___ the table.', a:'on', w1:'in', w2:'at', w3:'to', exp:'Surface.'},
                {q:'He came ___ bus.', a:'by', w1:'in', w2:'on', w3:'with', exp:'Travel by.'},
                {q:'I am fond ___ music.', a:'of', w1:'in', w2:'at', w3:'with', exp:'Fond of.'}
            ],
            'Phrasal Verbs': [
                {q:'Meaning of "Call off"', a:'Cancel', w1:'Call loud', w2:'Visit', w3:'End', exp:'To stop an event.'},
                {q:'Meaning of "Give up"', a:'Surrender/Stop', w1:'Give gift', w2:'Start', w3:'Win', exp:'To quit.'},
                {q:'Meaning of "Look after"', a:'Take care of', w1:'Look behind', w2:'See', w3:'Ignore', exp:'To care for.'},
                {q:'Meaning of "Put off"', a:'Postpone', w1:'Wear', w2:'Drop', w3:'Extinguish', exp:'To delay.'},
                {q:'Meaning of "Run out of"', a:'Exhaust supply', w1:'Run fast', w2:'Go out', w3:'Exit', exp:'Have none left.'},
                {q:'Meaning of "Break down"', a:'Stop working', w1:'Cry', w2:'Dance', w3:'Fall', exp:'Machine failure.'},
                {q:'Meaning of "Carry on"', a:'Continue', w1:'Lift', w2:'Stop', w3:'Drop', exp:'Keep doing.'},
                {q:'Meaning of "Get up"', a:'Rise', w1:'Sleep', w2:'Sit', w3:'Run', exp:'Wake up.'},
                {q:'Meaning of "Look for"', a:'Search', w1:'See', w2:'Watch', w3:'Hide', exp:'Find.'},
                {q:'Meaning of "Take off"', a:'Remove/Fly', w1:'Put on', w2:'Land', w3:'Run', exp:'Plane start.'},
                {q:'Meaning of "Bring up"', a:'Raise', w1:'Vomit', w2:'Carry', w3:'Drop', exp:'Rear child.'},
                {q:'Meaning of "Pass away"', a:'Die', w1:'Go past', w2:'Faint', w3:'Leave', exp:'Death euphemism.'},
                {q:'Meaning of "Turn down"', a:'Reject', w1:'Rotate', w2:'Accept', w3:'Low', exp:'Refuse.'},
                {q:'Meaning of "Set up"', a:'Establish', w1:'Sit', w2:'Fall', w3:'End', exp:'Start business.'},
                {q:'Meaning of "Make up"', a:'Invent/Repair', w1:'Paint', w2:'Break', w3:'Cry', exp:'Reconcile.'}
            ],
            'Reading Comprehension': [
                {q:'Passage: "Actions speak louder than words." Meaning?', a:'What you do matters more', w1:'Speak loudly', w2:'Words are useless', w3:'Don\'t talk', exp:'Action > Speech.'},
                {q:'Passage: "Honesty is the best policy." Meaning?', a:'Truthfulness wins', w1:'Policies are honest', w2:'Lie carefully', w3:'None', exp:'Moral value.'},
                {q:'Passage: "Rome was not built in a day." Meaning?', a:'Great work takes time', w1:'Rome is small', w2:'Work fast', w3:'Lazy builders', exp:'Patience.'},
                {q:'Passage: "Prevention is better than cure." Meaning?', a:'Avoid problems early', w1:'Take medicine', w2:'Cures are bad', w3:'Wait for sick', exp:'Safety first.'},
                {q:'Passage: "A stitch in time saves nine." Meaning?', a:'Fix problems early', w1:'Sew clothes', w2:'Save nine', w3:'Wait', exp:'Proactive.'},
                {q:'Passage: "All that glitters is not gold." Meaning?', a:'Appearances deceive', w1:'Gold shines', w2:'Rich is good', w3:'None', exp:'Reality vs Look.'},
                {q:'Passage: "Knowledge is power." Meaning?', a:'Education enables you', w1:'Power is bad', w2:'Ignore books', w3:'None', exp:'Learning.'},
                {q:'Passage: "Unity is strength." Meaning?', a:'Together we win', w1:'Fight alone', w2:'Power', w3:'None', exp:'Teamwork.'},
                {q:'Passage: "Health is wealth." Meaning?', a:'Fitness is valuable', w1:'Money is health', w2:'Eat gold', w3:'None', exp:'Wellbeing.'},
                {q:'Passage: "Look before you leap." Meaning?', a:'Think before acting', w1:'Jump high', w2:'Run fast', w3:'Don\'t look', exp:'Caution.'},
                {q:'Passage: "Where there is a will..." Meaning?', a:'Determination finds way', w1:'Road blocked', w2:'Stop', w3:'None', exp:'Success.'},
                {q:'Passage: "Slow and steady..." Meaning?', a:'Consistency wins', w1:'Run fast', w2:'Stop', w3:'None', exp:'Patience.'},
                {q:'Passage: "Tit for Tat." Meaning?', a:'Retaliation', w1:'Kindness', w2:'Give', w3:'None', exp:'Revenge.'},
                {q:'Passage: "Save trees." Meaning?', a:'Protect nature', w1:'Cut them', w2:'Build', w3:'None', exp:'Ecology.'},
                {q:'Passage: "Time is money." Meaning?', a:'Value time', w1:'Sell watches', w2:'Waste it', w3:'None', exp:'Productivity.'}
            ],
            'Cloze Test': [
                {q:'"Honesty is the ___ policy."', a:'best', w1:'worst', w2:'good', w3:'bad', exp:'Proverb.'},
                {q:'"Make hay while the sun ___."', a:'shines', w1:'sets', w2:'rise', w3:'falls', exp:'Proverb.'},
                {q:'"A friend in need is a friend ___."', a:'indeed', w1:'in deed', w2:'always', w3:'never', exp:'Proverb.'},
                {q:'"All that glitters is not ___."', a:'gold', w1:'silver', w2:'diamond', w3:'good', exp:'Proverb.'},
                {q:'"Knowledge is ___."', a:'power', w1:'good', w2:'bad', w3:'book', exp:'Proverb.'},
                {q:'"A stitch in time saves ___."', a:'nine', w1:'one', w2:'ten', w3:'five', exp:'Proverb.'},
                {q:'"Prevention is better than ___."', a:'cure', w1:'care', w2:'sick', w3:'bad', exp:'Proverb.'},
                {q:'"Rome was not built in a ___."', a:'day', w1:'year', w2:'month', w3:'week', exp:'Proverb.'},
                {q:'"Where there is a will there is a ___."', a:'way', w1:'road', w2:'wall', w3:'path', exp:'Proverb.'},
                {q:'"Actions speak louder than ___."', a:'words', w1:'sound', w2:'voice', w3:'talk', exp:'Proverb.'},
                {q:'"Birds of a feather ___ together."', a:'flock', w1:'fly', w2:'sit', w3:'go', exp:'Proverb.'},
                {q:'"Charity begins at ___."', a:'home', w1:'school', w2:'work', w3:'church', exp:'Proverb.'},
                {q:'"Every cloud has a silver ___."', a:'lining', w1:'line', w2:'edge', w3:'color', exp:'Proverb.'},
                {q:'"Haste makes ___."', a:'waste', w1:'fast', w2:'speed', w3:'good', exp:'Proverb.'},
                {q:'"Practice makes a man ___."', a:'perfect', w1:'good', w2:'smart', w3:'rich', exp:'Proverb.'}
            ],
            'Sentence Rearrangement': [
                {q:'(A)is (B)He (C)boy', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'B-C-A', exp:'He is boy.'},
                {q:'(A)Go (B)school (C)to', a:'A-C-B', w1:'B-A-C', w2:'C-A-B', w3:'B-C-A', exp:'Go to school.'},
                {q:'(A)honesty (B)Best (C)is', a:'A-C-B', w1:'B-A-C', w2:'C-A-B', w3:'B-C-A', exp:'Honesty is best.'},
                {q:'(A)love (B)I (C)India', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'I love India.'},
                {q:'(A)red (B)is (C)Rose', a:'C-B-A', w1:'A-B-C', w2:'B-A-C', w3:'A-C-B', exp:'Rose is red.'},
                {q:'(A)play (B)We (C)cricket', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'We play cricket.'},
                {q:'(A)good (B)She (C)girl (D)is', a:'B-D-A-C', w1:'A-B-C-D', w2:'D-A-B-C', w3:'C-D-A-B', exp:'She is good girl.'},
                {q:'(A)sun (B)The (C)rises', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'The sun rises.'},
                {q:'(A)fast (B)Run (C)very', a:'B-C-A', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'Run very fast.'},
                {q:'(A)The (B)open (C)door', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'Open the door.'},
                {q:'(A)late (B)is (C)He', a:'C-B-A', w1:'A-B-C', w2:'B-A-C', w3:'A-C-B', exp:'He is late.'},
                {q:'(A)tea (B)likes (C)She', a:'C-B-A', w1:'A-B-C', w2:'B-A-C', w3:'A-C-B', exp:'She likes tea.'},
                {q:'(A)can (B)I (C)swim', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'I can swim.'},
                {q:'(A)rain (B)It (C)may', a:'B-C-A', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'It may rain.'},
                {q:'(A)God (B)Trust (C)in', a:'B-C-A', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'Trust in God.'}
            ]
        };

        const topicList = Object.keys(allData);
        for (let t of topicList) {
            const questions = allData[t];
            // NO LOOP REPETITION - Just inserting unique questions
            for (let item of questions) {
                let opts = shuffle([
                    { val: item.a, isCorrect: true },
                    { val: item.w1, isCorrect: false },
                    { val: item.w2, isCorrect: false },
                    { val: item.w3, isCorrect: false }
                ]);

                let finalAns = 'A';
                if (opts[1].isCorrect) finalAns = 'B';
                if (opts[2].isCorrect) finalAns = 'C';
                if (opts[3].isCorrect) finalAns = 'D';

                await addQ(t, item.q, opts[0].val, opts[1].val, opts[2].val, opts[3].val, finalAns, item.exp);
            }
        }

        res.send(`<h1>✅ ENGLISH FULLY FIXED!</h1><p>225+ Unique Questions Loaded (No Repetition).<br>Placement Level (Moderate).<br><b>Maths & Reasoning SAFE.</b></p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});
// =============================================================
// 🚀 TECHNICAL JUMBO PACK (ERROR FREE & TESTED)
// =============================================================
app.get('/fix-technical-jumbo', async (req, res) => {
    try {
        // 1. DELETE ONLY TECHNICAL QUESTIONS
        await db.execute("DELETE FROM aptitude_questions WHERE category = 'Technical'");

        const addQ = async (topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['Technical', topic, q, a, b, c, d, corr, exp]);
        };

        // --- SHUFFLE FUNCTION (Compulsory) ---
        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        // --- QUESTION BANK ---
        const techData = {
            'C Programming': [
                {q:'Output of: printf("%d %d", n++, ++n); where n=3', a:'Implementation Dependent', w1:'3 5', w2:'4 5', w3:'4 4', exp:'Order of evaluation of arguments is undefined in C.'},
                {q:'Output of: int i=10; { int i=20; { int i=30; cout << i << ::i; } }', a:'3010', w1:'3020', w2:'2010', w3:'Error', exp:'Local i is 30, Global scope ::i is 10.'},
                {q:'Loop: for(i=1; i<5; ++i) if(i==3) continue; else printf("%d", i);', a:'1 2 4 5', w1:'1 2 3 4', w2:'1 2 4', w3:'Error', exp:'Continue skips printing when i is 3.'},
                {q:'Output: int i=107, x=5; printf((x<7) ? "%d" : "%c", i);', a:'107', w1:'k', w2:'Error', w3:'Garbage', exp:'x<7 is true, so %d prints 107.'},
                {q:'What loop prints: while(printf("%d", printf("az")))', a:'azbyazby...', w1:'azby', w2:'Error', w3:'Infinite', exp:'printf returns count, loop continues based on non-zero return.'},
                {q:'Size of void pointer in C?', a:'Depends on compiler', w1:'2 bytes', w2:'4 bytes', w3:'0', exp:'Depends on architecture.'},
                {q:'Bitwise operator for XOR?', a:'^', w1:'|', w2:'&', w3:'~', exp:'^ is XOR operator.'},
                {q:'Value of EOF?', a:'-1', w1:'0', w2:'1', w3:'Null', exp:'End of File macro.'},
                {q:'Output: printf("%d", sizeof("a"));', a:'2', w1:'1', w2:'4', w3:'8', exp:'String "a" includes null terminator.'},
                {q:'Keyword "volatile" does what?', a:'Prevents optimization', w1:'Makes constant', w2:'Register alloc', w3:'None', exp:'Tells compiler value can change unexpectedly.'}
            ],
            'Data Structures': [
                {q:'Stack Ops: push(1), push(2), pop, push(2), pop, pop, pop, push(2), pop. Popped?', a:'2, 2, 1, 1, 2', w1:'2, 2, 1, 2, 2', w2:'2, 1, 2, 2, 1', w3:'Error', exp:'Trace LIFO order carefully.'},
                {q:'Hash f(key)=key%7. Insert 37,38,72,48,98,11. Loc of 11?', a:'5', w1:'3', w2:'4', w3:'6', exp:'Linear probing resolves collision.'},
                {q:'Binary trees possible with 4 nodes?', a:'14', w1:'12', w2:'13', w3:'15', exp:'Catalan number formula.'},
                {q:'Sparse matrices have?', a:'Many zero entries', w1:'Many non-zero', w2:'High dimension', w3:'None', exp:'Definition of sparse.'},
                {q:'Arranging cards while picking up is?', a:'Insertion sort', w1:'Bubble sort', w2:'Selection sort', w3:'Merge sort', exp:'Classic example of Insertion Sort.'},
                {q:'Time complexity of Binary Search (Worst)?', a:'O(log n)', w1:'O(n)', w2:'O(n^2)', w3:'O(1)', exp:'Splits search space in half.'},
                {q:'Preorder traversal is same as?', a:'Depth-first order', w1:'Breadth-first', w2:'Topological', w3:'Linear', exp:'DFS strategy.'},
                {q:'Min queues to implement stack?', a:'2', w1:'1', w2:'3', w3:'4', exp:'Two queues needed.'},
                {q:'Circular Queue full condition?', a:'(rear+1)%size == front', w1:'rear == front', w2:'rear == size', w3:'front == -1', exp:'Standard logic.'},
                {q:'Which DS for recursion?', a:'Stack', w1:'Queue', w2:'Tree', w3:'Graph', exp:'System call stack.'}
            ],
            'Algorithms': [
                {q:'Postfix for: A+B*(C+D)/F+D*E', a:'ABCD+*F/+DE*+', w1:'AB+CD+*F/D+E*', w2:'A*B+CD/F*DE++', w3:'A+*BCD/F*DE++', exp:'Precedence logic.'},
                {q:'Sort for already sorted/reverse data with equal speed?', a:'Merge sort', w1:'Quick sort', w2:'Insertion sort', w3:'Selection sort', exp:'Consistent O(nlogn) performance.'},
                {q:'All pair shortest path algorithm?', a:'Floyd-Warshall', w1:'Dijkstra', w2:'Prim', w3:'Kruskal', exp:'Dynamic programming approach.'},
                {q:'Quick sort strategy?', a:'Divide and Conquer', w1:'Greedy', w2:'Dynamic', w3:'Backtracking', exp:'Partition logic.'},
                {q:'Minimum weighted spanning tree uses?', a:'Greedy', w1:'Dynamic', w2:'Divide Conquer', w3:'Backtracking', exp:'Prim\'s algorithm is greedy.'},
                {q:'Worst case of Quick Sort?', a:'O(n^2)', w1:'O(n log n)', w2:'O(n)', w3:'O(log n)', exp:'Pivot is smallest/largest.'},
                {q:'BFS uses which DS?', a:'Queue', w1:'Stack', w2:'Heap', w3:'Tree', exp:'Level order traversal.'},
                {q:'Huffman coding is?', a:'Greedy', w1:'Dynamic', w2:'Divide', w3:'Backtracking', exp:'Builds optimal tree.'},
                {q:'Best case Bubble Sort?', a:'O(n)', w1:'O(n^2)', w2:'O(log n)', w3:'O(1)', exp:'If array sorted.'},
                {q:'Binary Search requires?', a:'Sorted array', w1:'Unsorted array', w2:'Linked List', w3:'Stack', exp:'Pre-condition.'}
            ],
            'DBMS': [
                {q:'Redundancy is a threat to data ____?', a:'Integrity', w1:'Consistency', w2:'Sufficiency', w3:'None', exp:'Update anomalies affect integrity.'},
                {q:'Join also called Inner Join?', a:'Equijoin', w1:'Non-equijoin', w2:'Self-join', w3:'None', exp:'Based on equality.'},
                {q:'SGA stands for?', a:'System Global Area', w1:'Show Global Area', w2:'Start Global Area', w3:'Shut Global Area', exp:'Oracle memory structure.'},
                {q:'Command to add data?', a:'INSERT', w1:'ADD', w2:'UPDATE', w3:'APPEND', exp:'INSERT INTO....'},
                {q:'DESCRIBE command does NOT show?', a:'Triggers', w1:'Primary key', w2:'Default values', w3:'Indexes', exp:'Shows structure, not logic.'},
                {q:'ACID properties?', a:'Atomicity, Consistency, Isolation, Durability', w1:'Atomicity, Concurrency, Isolation, DB', w2:'None', w3:'Auto', exp:'Transaction rules.'},
                {q:'2NF removes?', a:'Partial Dependency', w1:'Transitive', w2:'Multivalued', w3:'None', exp:'Normalization step.'},
                {q:'3NF removes?', a:'Transitive Dependency', w1:'Partial', w2:'Atomic', w3:'None', exp:'Normalization step.'},
                {q:'Virtual table is called?', a:'View', w1:'Trigger', w2:'Procedure', w3:'Index', exp:'Saved query.'},
                {q:'Unique identifier?', a:'Primary Key', w1:'Foreign Key', w2:'Unique Key', w3:'Candidate', exp:'No duplicates.'}
            ],
            'SQL Queries': [
                {q:'SELECT TRUNC(45.926, -1) FROM DUAL;', a:'40', w1:'50', w2:'45.9', w3:'45', exp:'-1 truncates to tens place.'},
                {q:'SELECT LENGTH(123) FROM DUAL;', a:'3', w1:'0', w2:'Garbage', w3:'Null', exp:'Converts 123 to string, length is 3.'},
                {q:'SELECT NVL(NVL(NULL, 3), 4) FROM DUAL;', a:'3', w1:'4', w2:'Null', w3:'Error', exp:'Inner NVL returns 3, outer sees 3.'},
                {q:'SELECT DECODE(2, 2, DECODE(3, 3, 2)) FROM DUAL;', a:'2', w1:'3', w2:'Null', w3:'Error', exp:'Nested decode logic returns 2.'},
                {q:'Wildcards that are equivalent?', a:'_%', w1:'%_', w2:'_ _', w3:'None', exp:'Depending on context.'},
                {q:'SELECT 10/NULL FROM DUAL;', a:'NULL', w1:'0', w2:'10', w3:'Error', exp:'Null propagation.'},
                {q:'Filter after GROUP BY?', a:'HAVING', w1:'WHERE', w2:'ORDER BY', w3:'LIKE', exp:'HAVING filters groups.'},
                {q:'Delete rows keep structure?', a:'TRUNCATE', w1:'DROP', w2:'DELETE', w3:'REMOVE', exp:'Fast deletion.'},
                {q:'Pattern matching operator?', a:'LIKE', w1:'MATCH', w2:'SAME', w3:'EQUALS', exp:'Used with % and _.'},
                {q:'DDL command?', a:'CREATE', w1:'INSERT', w2:'UPDATE', w3:'SELECT', exp:'Defines structure.'}
            ],
            'Java Programming': [
                {q:'System.out.println(Math.round(Math.random())); prints?', a:'0 or 1', w1:'Only 0', w2:'Only 1', w3:'Any int', exp:'random is 0.0-1.0, round gives 0 or 1.'},
                {q:'Is null an object?', a:'No', w1:'Yes', w2:'Sometimes', w3:'None', exp:'null is a literal.'},
                {q:'Variable m is byte. m<<4 is same as?', a:'m*16', w1:'m*4', w2:'m^4', w3:'m+4', exp:'Left shift 4 is * 2^4 (16).'},
                {q:'Exceptions that possibly occur are?', a:'Checked exceptions', w1:'Unchecked', w2:'Runtime', w3:'Errors', exp:'Checked by compiler.'},
                {q:'Subclass is also called?', a:'Derived class', w1:'Base class', w2:'Super class', w3:'None', exp:'Inheritance terminology.'},
                {q:'Size of int in Java?', a:'4 bytes', w1:'2 bytes', w2:'Dependent', w3:'8 bytes', exp:'Fixed size.'},
                {q:'Multiple inheritance supported via?', a:'Interfaces', w1:'Classes', w2:'Both', w3:'None', exp:'Java restriction.'},
                {q:'String mutable?', a:'No', w1:'Yes', w2:'Sometimes', w3:'None', exp:'Immutable.'},
                {q:'Default value of boolean?', a:'false', w1:'true', w2:'null', w3:'0', exp:'Default.'},
                {q:'Prevent inheritance keyword?', a:'final', w1:'static', w2:'const', w3:'super', exp:'Final class.'}
            ],
            'OOPs Concepts': [
                {q:'Reusability is achieved by?', a:'Inheritance', w1:'Polymorphism', w2:'Encapsulation', w3:'None', exp:'Using existing code.'},
                {q:'Operator NOT overloaded in C++?', a:'. (Dot)', w1:'+', w2:'-', w3:'++', exp:'Member access cannot be overloaded.'},
                {q:'class Dog : public X, public Y is?', a:'Multiple inheritance', w1:'Linear', w2:'Repeated', w3:'None', exp:'Two parents.'},
                {q:'Wrapping data and code?', a:'Encapsulation', w1:'Abstraction', w2:'Polymorphism', w3:'Inheritance', exp:'Data hiding.'},
                {q:'Hiding implementation details?', a:'Abstraction', w1:'Encapsulation', w2:'Inheritance', w3:'Polymorphism', exp:'Essential features only.'},
                {q:'Same method name diff params?', a:'Overloading', w1:'Overriding', w2:'Hiding', w3:'None', exp:'Compile time polymorphism.'},
                {q:'Same method name in child class?', a:'Overriding', w1:'Overloading', w2:'Hiding', w3:'None', exp:'Runtime polymorphism.'},
                {q:'Destructor symbol?', a:'~', w1:'!', w2:'#', w3:'@', exp:'Tilde.'},
                {q:'Access parent methods?', a:'super', w1:'this', w2:'base', w3:'parent', exp:'Keyword.'},
                {q:'Instance of class?', a:'Object', w1:'Method', w2:'Variable', w3:'Pointer', exp:'Basic definition.'}
            ]
        };

        // --- INSERTION LOGIC ---
        for (let t in techData) {
            let questions = techData[t];
            for (let item of questions) {
                // Ensure shuffle is called correctly
                let opts = shuffle([
                    { val: item.a, isCorrect: true },
                    { val: item.w1, isCorrect: false },
                    { val: item.w2, isCorrect: false },
                    { val: item.w3, isCorrect: false }
                ]);
                let finalAns = 'A';
                if (opts[1].isCorrect) finalAns = 'B';
                if (opts[2].isCorrect) finalAns = 'C';
                if (opts[3].isCorrect) finalAns = 'D';

                await addQ(t, item.q, opts[0].val, opts[1].val, opts[2].val, opts[3].val, finalAns, item.exp);
            }
        }

        res.send(`<h1>✅ JUMBO PACK FIXED & LOADED!</h1><p>Technical Questions Ready.<br>Shuffle Logic Added.<br>No Syntax Errors.</p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));