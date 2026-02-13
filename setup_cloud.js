const mysql = require('mysql2/promise');

// 👇 ENTER YOUR AIVEN DETAILS HERE 👇
const dbConfig = {
    host: 'mysql-35bb86-venusri2583-7956.l.aivencloud.com', // I copied this from your error image
    user: 'avnadmin',
    password: 'AVNS_dx-Vmix3iagEc9TR9Nl',     // ⚠️ PASTE YOUR AIVEN PASSWORD HERE
    database: 'defaultdb',
    port: 15926,                              // I copied this from your error image
    ssl: { rejectUnauthorized: false },       // ✅ This fixes the SSL error
    connectTimeout: 20000                     // Gives it more time to connect
};

const setup = async () => {
    let connection;
    try {
        console.log("⏳ Attempting to connect to Cloud...");
        connection = await mysql.createConnection(dbConfig);
        console.log("✅ Connected! Creating tables...");

        // 1. Create Users Table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log(" - Users Table Created");

        // 2. Create Mock Results Table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS mock_results (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                score INT,
                total INT,
                topic VARCHAR(255),
                test_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log(" - Mock Results Table Created");

        // 3. Create Resumes Table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_resumes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                full_name VARCHAR(255),
                email VARCHAR(255),
                phone_number VARCHAR(50),
                persona_type VARCHAR(50),
                linkedin_link TEXT,
                github_link TEXT,
                career_objective TEXT,
                projects_json JSON,
                technical_skills TEXT,
                strengths TEXT,
                languages_known TEXT,
                hobbies TEXT,
                certifications TEXT,
                high_qual_name VARCHAR(255),
                high_qual_college VARCHAR(255),
                high_qual_loc VARCHAR(255),
                high_qual_score VARCHAR(50),
                inter_qual_name VARCHAR(255),
                inter_college VARCHAR(255),
                inter_college_loc VARCHAR(255),
                inter_score VARCHAR(50),
                school_name_10th VARCHAR(255),
                school_10th_loc VARCHAR(255),
                score_10th VARCHAR(50),
                ats_score INT DEFAULT 0,
                template_style VARCHAR(50) DEFAULT 'modern',
                file_path TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log(" - Resumes Table Created");
        
        // 4. Create Questions Table
         await connection.execute(`
             CREATE TABLE IF NOT EXISTS aptitude_questions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                category VARCHAR(50), 
                topic VARCHAR(100),
                question TEXT NOT NULL,
                option_a VARCHAR(255) NOT NULL,
                option_b VARCHAR(255) NOT NULL,
                option_c VARCHAR(255) NOT NULL,
                option_d VARCHAR(255) NOT NULL,
                correct_option CHAR(1) NOT NULL,
                explanation TEXT
            )
        `);
        console.log(" - Questions Table Created");

        console.log("\n🎉 SUCCESS! You can now Register on your website.");

    } catch (err) {
        console.error("\n❌ ERROR:", err.message);
        console.log("💡 TIP: If this failed, try connecting your laptop to a Mobile Hotspot instead of College Wi-Fi.");
    } finally {
        if (connection) await connection.end();
    }
};

setup();