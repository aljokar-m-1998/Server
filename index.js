import express from "express";
import axios from "axios";
import cors from "cors";
import { PDFDocument, StandardFonts, rgb, degrees, grayscale } from "pdf-lib";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse"; // Required for text extraction
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import rateLimit from "express-rate-limit";

// =================================================================
// 👑 Core Configuration 👑
// =================================================================

const app = express();
const PORT = process.env.PORT || 3000;

// -- Supabase Config (UNCHANGED) --
const SUPABASE_URL = "https://tdqewqarcvdunwuxgios.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkcWV3cWFyY3ZkdW53dXhnaW9zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0ODc4NDcsImV4cCI6MjA4MTA2Mzg0N30.RSMghTLwda7kLidTohBFLqE7qCQoHs3S6l88ewUidRw";
const BUCKET_NAME = "pdf-files";
const LANDING_BUCKET = "landing-assets";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// -- Cloudflare Pages Config (UNCHANGED) --
const CF_ACCOUNT_ID = "35051f0d070872b7a1714e13ace50115";
const CF_API_TOKEN = "cvukv7Th8dUcvPP9tKU9gIB2n9bSKVKYv-UpHMce";
const CF_PROJECT_NAME = "m-h";
const CF_API_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${CF_PROJECT_NAME}/deployments`;

const MAX_SIZE_BYTES = 150 * 1024 * 1024; // 150MB

// -- Path Helpers --
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =================================================================
// 🛡️ Middleware & Auth System 🛡️
// =================================================================

app.use(express.json({ limit: "50mb" }));
app.use(cors());

// 1. In-Memory Rate Limit Store (UserId -> { count, startTime })
const userRateLimits = new Map();

/**
 * Middleware: Authenticate User via x-api-key
 * - Checks 'users' table in Supabase.
 * - Attaches user object to req.user.
 */
async function authenticateApiKey(req, res, next) {
  // Allow health and root without key
  if (req.path === "/" || req.path === "/health") return next();

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    return res.status(401).json({ ok: false, error: "Missing x-api-key header" });
  }

  try {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("api_key", apiKey)
      .single();

    if (error || !data) {
      return res.status(401).json({ ok: false, error: "Invalid API Key" });
    }

    req.user = data; // Attach user info (id, plan, etc.)
    next();
  } catch (err) {
    console.error("Auth Error:", err);
    res.status(500).json({ ok: false, error: "Auth Check Failed" });
  }
}

/**
 * Middleware: Rate Limit based on User Plan
 * - Free: 100 req / 15 min
 * - Pro: 1000 req / 15 min
 */
function rateLimitMiddleware(req, res, next) {
  if (!req.user) return next(); // Should ideally be caught by auth middleware

  const userId = req.user.id;
  const plan = req.user.plan || "free";
  const limit = plan === "pro" ? 1000 : 100;
  const windowMs = 15 * 60 * 1000; // 15 minutes

  const now = Date.now();
  let userRecord = userRateLimits.get(userId);

  if (!userRecord) {
    userRecord = { count: 1, startTime: now };
  } else {
    if (now - userRecord.startTime > windowMs) {
      // Reset window
      userRecord = { count: 1, startTime: now };
    } else {
      userRecord.count++;
    }
  }

  userRateLimits.set(userId, userRecord);

  if (userRecord.count > limit) {
    return res.status(429).json({
      ok: false,
      error: `Rate limit exceeded for ${plan} plan. Limit: ${limit} requests per 15 mins.`,
    });
  }

  next();
}

// Apply Auth & Rate Limiting to ALL API routes
app.use(authenticateApiKey);
app.use(rateLimitMiddleware);

// =================================================================
// 🛠️ General Helper Functions 🛠️
// =================================================================

function createTempFile(prefix = "file", extension = ".pdf") {
  const random = Math.random().toString(36).substring(2, 10);
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${random}${extension}`);
}

function safeDelete(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

async function downloadToTempFile(url, extension = ".pdf") {
  const tempPath = createTempFile("source", extension);
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    maxContentLength: MAX_SIZE_BYTES + 10 * 1024 * 1024,
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);
    let error = null;
    writer.on("error", (err) => {
      error = err;
      writer.close();
      reject(err);
    });
    writer.on("close", () => {
      if (!error) resolve(tempPath);
    });
  });
}

async function ensureSizeLimit(filePath) {
  const stats = fs.statSync(filePath);
  if (stats.size > MAX_SIZE_BYTES) {
    safeDelete(filePath);
    throw new Error(`File too large (max ${(MAX_SIZE_BYTES / (1024 * 1024)).toFixed(0)}MB)`);
  }
  return stats.size;
}

async function uploadBufferToSupabase(buffer, filename, bucketName = BUCKET_NAME, contentType = "application/pdf") {
  const fileExtension = path.extname(filename);
  const baseName = path.basename(filename, fileExtension);
  const filePath = `${bucketName === BUCKET_NAME ? "pdfs" : "assets"}/${baseName}-${Date.now()}${fileExtension}`;

  const { error } = await supabase.storage.from(bucketName).upload(filePath, buffer, { contentType, upsert: true });

  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  
  const { data } = supabase.storage.from(bucketName).getPublicUrl(filePath);
  return data.publicUrl;
}

/**
 * Standardized Logging to Supabase
 */
async function saveLog(action, req, extraInfo = {}) {
  try {
    const payload = {
      action,
      user_id: req.user ? req.user.id : null,
      ip: req.ip,
      endpoint: req.originalUrl,
      extra: extraInfo,
    };
    await supabase.from("logs").insert([payload]);
  } catch (err) {
    console.error("Log failed:", err.message);
  }
}

function sendPdfFile(res, filePath, fileName, cleanupPaths = []) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName || "file.pdf"}"`);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("close", () => cleanupPaths.forEach(safeDelete));
  stream.on("error", () => { cleanupPaths.forEach(safeDelete); });
}

// =================================================================
// 🎨 Image & Cloudflare Helpers 🎨
// =================================================================

async function optimizeBase64Image(rawBase64) {
  try {
    const base64Data = rawBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, 'base64');
    if (imageBuffer.length > MAX_SIZE_BYTES) throw new Error("Image too large");
    
    const webpBuffer = await sharp(imageBuffer)
      .resize({ width: 1000, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
      
    return `data:image/webp;base64,${webpBuffer.toString("base64")}`;
  } catch (error) {
    console.error("Image Processing Error:", error);
    throw new Error("Failed to process image.");
  }
}

async function deployHtmlToCloudflare(htmlContent, pageName) {
  const tempDir = createTempFile(pageName, "");
  fs.mkdirSync(tempDir, { recursive: true });
  const fileName = "index.html";
  const htmlPath = path.join(tempDir, fileName);
  fs.writeFileSync(htmlPath, htmlContent, "utf-8");

  const FormData = (await import('form-data')).default;
  const formData = new FormData();
  formData.append("index.html", fs.createReadStream(htmlPath), fileName);

  try {
    const response = await axios.post(CF_API_BASE, formData, {
      headers: { Authorization: `Bearer ${CF_API_TOKEN}`, ...formData.getHeaders() },
      maxContentLength: Infinity, maxBodyLength: Infinity,
    });
    if (response.data.success) {
      return `https://${CF_PROJECT_NAME}.pages.dev/${pageName}/`;
    }
    throw new Error("Deployment reported failure");
  } catch (error) {
    throw new Error(`Cloudflare Error: ${error.message}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// =================================================================
// 📄 HTML Templates (Improved) 📄
// =================================================================

function generateLandingPageHtml({ title, description, imageUrl, primaryColor, ctaLink, ctaText, features }) {
  const color = primaryColor || "#4F46E5";
  const featuresHtml = features && Array.isArray(features) 
    ? `<div class="features-grid">${features.map(f => `<div class="feature-card"><h3>${f.title}</h3><p>${f.desc}</p></div>`).join('')}</div>` 
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        :root { --primary: ${color}; }
        body { font-family: system-ui, -apple-system, sans-serif; margin: 0; line-height: 1.6; color: #1f2937; background: #f9fafb; }
        .hero { background: white; padding: 4rem 1rem; text-align: center; }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 1rem; color: #111827; }
        p.lead { font-size: 1.25rem; color: #6b7280; margin-bottom: 2rem; }
        .img-wrapper { margin: 2rem 0; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); border-radius: 1rem; overflow: hidden; }
        img { width: 100%; height: auto; display: block; }
        .btn { display: inline-block; background: var(--primary); color: white; padding: 0.75rem 2rem; border-radius: 0.5rem; text-decoration: none; font-weight: 600; transition: 0.2s; }
        .btn:hover { opacity: 0.9; transform: translateY(-1px); }
        .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 2rem; padding: 4rem 1rem; }
        .feature-card { background: white; padding: 1.5rem; border-radius: 0.5rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    </style>
</head>
<body>
    <div class="hero">
        <div class="container">
            ${imageUrl ? `<div class="img-wrapper"><img src="${imageUrl}" alt="Hero"></div>` : ""}
            <h1>${title}</h1>
            <p class="lead">${description}</p>
            ${ctaLink ? `<a href="${ctaLink}" class="btn">${ctaText || "Get Started"}</a>` : ""}
        </div>
    </div>
    <div class="container">
        ${featuresHtml}
    </div>
</body>
</html>`;
}

function generateBioPageHtml({ name, bio, profileImageUrl, links, themeColor }) {
  const color = themeColor || "#000000";
  const linkHtml = links ? links.map(l => 
    `<a href="${l.url}" target="_blank" class="link-card">${l.text}</a>`
  ).join("") : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${name}</title>
    <style>
        body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem 1rem; background: ${color}; color: white; min-height: 100vh; display: flex; flex-direction: column; align-items: center; }
        .profile-container { text-align: center; margin-bottom: 2rem; }
        .avatar { width: 96px; height: 96px; border-radius: 50%; border: 4px solid rgba(255,255,255,0.2); object-fit: cover; margin-bottom: 1rem; }
        h1 { margin: 0; font-size: 1.5rem; font-weight: 700; }
        p { margin: 0.5rem 0 0; opacity: 0.9; font-size: 0.95rem; max-width: 400px; }
        .links-container { width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: 1rem; }
        .link-card { background: white; color: ${color}; padding: 1rem; text-align: center; text-decoration: none; border-radius: 3rem; font-weight: 600; transition: transform 0.2s; }
        .link-card:hover { transform: scale(1.02); opacity: 0.95; }
    </style>
</head>
<body>
    <div class="profile-container">
        ${profileImageUrl ? `<img src="${profileImageUrl}" alt="${name}" class="avatar">` : ""}
        <h1>${name}</h1>
        <p>${bio}</p>
    </div>
    <div class="links-container">
        ${linkHtml}
    </div>
</body>
</html>`;
}

// =================================================================
// 🚀 1. Root & Health Endpoints 🚀
// =================================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "SaaS PDF & Page Builder API (v2)",
    docs: "See endpoint list below. Auth required (x-api-key) for tools.",
    endpoints: {
      pdf: ["/pdf/compress", "/pdf/merge", "/pdf/split", "/pdf/rotate-pages", "/pdf/extract-text", "/pdf/watermark-text", "/pdf/metadata", "/pdf/reorder-pages", "/pdf/delete-pages"],
      saas: ["GET/POST/DELETE /saas/landing-page", "GET/POST/DELETE /saas/bio-page"]
    }
  });
});

app.get("/health", async (req, res) => {
  const start = Date.now();
  let dbStatus = "unknown";
  try {
    const { error } = await supabase.from("logs").select("id").limit(1);
    dbStatus = error ? "error" : "connected";
  } catch (e) { dbStatus = "error"; }

  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    db_status: dbStatus,
    latency: `${Date.now() - start}ms`
  });
});

// =================================================================
// 🚀 2. PDF Tools API (Advanced) 🚀
// =================================================================

// Helper to record PDF op
async function recordPdfOp(req, action, url, size, meta = {}) {
  await supabase.from("pdf_files").insert([{
    user_id: req.user.id, action, url, size_bytes: size, metadata: meta
  }]);
  await saveLog(action, req, { size, ...meta });
}

// --- A. Compress ---
app.post("/pdf/compress", async (req, res) => {
  let source, output;
  try {
    const { publicUrl } = req.body;
    source = await downloadToTempFile(publicUrl);
    const pdfDoc = await PDFDocument.load(fs.readFileSync(source));
    
    // "Compression" by saving without object streams and removed unused objects
    const compressedBytes = await pdfDoc.save({ useObjectStreams: false }); 
    
    output = createTempFile("compressed");
    fs.writeFileSync(output, compressedBytes);
    
    const upUrl = await uploadBufferToSupabase(Buffer.from(compressedBytes), "compressed.pdf");
    await recordPdfOp(req, "compress", upUrl, compressedBytes.length);
    
    sendPdfFile(res, output, "compressed.pdf", [source, output]);
  } catch (err) {
    safeDelete(source); safeDelete(output);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- B. Merge ---
app.post("/pdf/merge", async (req, res) => {
  let tempFiles = [], output;
  try {
    const { publicUrls } = req.body; // Array of URLs
    const mergeDoc = await PDFDocument.create();
    
    for (const url of publicUrls) {
      const p = await downloadToTempFile(url);
      tempFiles.push(p);
      const doc = await PDFDocument.load(fs.readFileSync(p));
      const pages = await mergeDoc.copyPages(doc, doc.getPageIndices());
      pages.forEach(pg => mergeDoc.addPage(pg));
    }
    
    const bytes = await mergeDoc.save();
    output = createTempFile("merged");
    fs.writeFileSync(output, bytes);
    
    const upUrl = await uploadBufferToSupabase(Buffer.from(bytes), "merged.pdf");
    await recordPdfOp(req, "merge", upUrl, bytes.length, { count: publicUrls.length });

    sendPdfFile(res, output, "merged.pdf", [...tempFiles, output]);
  } catch (err) {
    tempFiles.forEach(safeDelete); safeDelete(output);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- C. Rotate ---
app.post("/pdf/rotate-pages", async (req, res) => {
  let source, output;
  try {
    const { publicUrl, pages, angle } = req.body; // angle: 90, 180, 270
    source = await downloadToTempFile(publicUrl);
    const pdf = await PDFDocument.load(fs.readFileSync(source));
    const angleNum = parseInt(angle);
    
    // Logic to select pages (simple array or all)
    const pageIndices = pages ? pages.map(p => p - 1) : pdf.getPageIndices();
    
    pageIndices.forEach(idx => {
      if (idx >= 0 && idx < pdf.getPageCount()) {
        const p = pdf.getPage(idx);
        p.setRotation(degrees(p.getRotation().angle + angleNum));
      }
    });

    const bytes = await pdf.save();
    output = createTempFile("rotated");
    fs.writeFileSync(output, bytes);
    
    const upUrl = await uploadBufferToSupabase(Buffer.from(bytes), "rotated.pdf");
    await recordPdfOp(req, "rotate", upUrl, bytes.length, { angle });
    
    sendPdfFile(res, output, "rotated.pdf", [source, output]);
  } catch (err) {
    safeDelete(source); safeDelete(output);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- D. Split (New) ---
app.post("/pdf/split", async (req, res) => {
  let source;
  try {
    const { publicUrl, ranges } = req.body; // ranges: "1-3, 5, 7-9" or null (explode all)
    source = await downloadToTempFile(publicUrl);
    const srcPdf = await PDFDocument.load(fs.readFileSync(source));
    const totalPages = srcPdf.getPageCount();
    
    let parts = [];
    
    // Helper to process range string
    const getIndices = (rangeStr) => {
        const idxs = new Set();
        rangeStr.split(',').forEach(part => {
            const [s, e] = part.trim().split('-').map(n => parseInt(n));
            if (!isNaN(s)) {
                if (isNaN(e)) idxs.add(s - 1);
                else for(let i=s; i<=e; i++) idxs.add(i - 1);
            }
        });
        return [...idxs].filter(i => i >= 0 && i < totalPages).sort((a,b)=>a-b);
    };

    if (ranges) {
        // Create one PDF per defined range? Or simply split specific pages?
        // Logic: Create NEW PDF for the specified range.
        const indices = getIndices(ranges);
        const newDoc = await PDFDocument.create();
        const copied = await newDoc.copyPages(srcPdf, indices);
        copied.forEach(p => newDoc.addPage(p));
        parts.push({ name: `split_${ranges}`, doc: newDoc });
    } else {
        // Explode: One PDF per page
        for (let i = 0; i < totalPages; i++) {
            const newDoc = await PDFDocument.create();
            const [copied] = await newDoc.copyPages(srcPdf, [i]);
            newDoc.addPage(copied);
            parts.push({ name: `page_${i + 1}`, doc: newDoc });
        }
    }

    // Save and Upload all parts
    const resultUrls = [];
    for (const part of parts) {
        const bytes = await part.doc.save();
        const url = await uploadBufferToSupabase(Buffer.from(bytes), `${part.name}.pdf`);
        resultUrls.push({ name: part.name, url });
    }

    await recordPdfOp(req, "split", "multiple", 0, { count: resultUrls.length });
    safeDelete(source);
    
    res.json({ ok: true, parts: resultUrls });

  } catch (err) {
    safeDelete(source);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- E. Extract Text (New) ---
app.post("/pdf/extract-text", async (req, res) => {
  let source;
  try {
    const { publicUrl } = req.body;
    source = await downloadToTempFile(publicUrl);
    const buffer = fs.readFileSync(source);
    
    const data = await pdfParse(buffer);
    
    await recordPdfOp(req, "extract-text", publicUrl, buffer.length);
    safeDelete(source);
    
    res.json({ ok: true, text: data.text, info: data.info, pages: data.numpages });
  } catch (err) {
    safeDelete(source);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- F. Watermark (New) ---
app.post("/pdf/watermark-text", async (req, res) => {
  let source, output;
  try {
    const { publicUrl, text, size = 50, opacity = 0.5, colorHex = "#FF0000" } = req.body;
    source = await downloadToTempFile(publicUrl);
    const pdf = await PDFDocument.load(fs.readFileSync(source));
    
    const r = parseInt(colorHex.slice(1, 3), 16) / 255;
    const g = parseInt(colorHex.slice(3, 5), 16) / 255;
    const b = parseInt(colorHex.slice(5, 7), 16) / 255;

    const pages = pdf.getPages();
    pages.forEach(page => {
        const { width, height } = page.getSize();
        page.drawText(text, {
            x: width / 2 - (text.length * size) / 4, // Approx center
            y: height / 2,
            size: Number(size),
            color: rgb(r, g, b),
            opacity: Number(opacity),
            rotate: degrees(45),
        });
    });

    const bytes = await pdf.save();
    output = createTempFile("watermarked");
    fs.writeFileSync(output, bytes);

    const upUrl = await uploadBufferToSupabase(Buffer.from(bytes), "watermark.pdf");
    await recordPdfOp(req, "watermark", upUrl, bytes.length);
    
    sendPdfFile(res, output, "watermarked.pdf", [source, output]);
  } catch (err) {
    safeDelete(source); safeDelete(output);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- G. Metadata (New) ---
app.post("/pdf/metadata", async (req, res) => {
    let source;
    try {
      const { publicUrl, update } = req.body; // update = { title: "New" } (optional)
      source = await downloadToTempFile(publicUrl);
      const pdf = await PDFDocument.load(fs.readFileSync(source));
      
      if (update) {
          if (update.title) pdf.setTitle(update.title);
          if (update.author) pdf.setAuthor(update.author);
          if (update.subject) pdf.setSubject(update.subject);
          
          const bytes = await pdf.save();
          const upUrl = await uploadBufferToSupabase(Buffer.from(bytes), "meta_updated.pdf");
          await recordPdfOp(req, "metadata-update", upUrl, bytes.length);
          safeDelete(source);
          return res.json({ ok: true, url: upUrl });
      }

      const meta = {
          title: pdf.getTitle(),
          author: pdf.getAuthor(),
          subject: pdf.getSubject(),
          pageCount: pdf.getPageCount()
      };
      
      safeDelete(source);
      res.json({ ok: true, metadata: meta });
    } catch (err) {
      safeDelete(source);
      res.status(500).json({ ok: false, error: err.message });
    }
});

// --- H. Reorder / Delete Pages (New) ---
app.post("/pdf/reorder-pages", async (req, res) => {
    let source, output;
    try {
        const { publicUrl, order } = req.body; // order: [3, 1, 2] (1-based)
        if(!Array.isArray(order)) throw new Error("order array required");

        source = await downloadToTempFile(publicUrl);
        const srcPdf = await PDFDocument.load(fs.readFileSync(source));
        const newDoc = await PDFDocument.create();

        // 0-based indices
        const indices = order.map(n => parseInt(n) - 1).filter(i => i >= 0 && i < srcPdf.getPageCount());
        const copied = await newDoc.copyPages(srcPdf, indices);
        copied.forEach(p => newDoc.addPage(p));

        const bytes = await newDoc.save();
        output = createTempFile("reordered");
        fs.writeFileSync(output, bytes);

        const upUrl = await uploadBufferToSupabase(Buffer.from(bytes), "reordered.pdf");
        await recordPdfOp(req, "reorder", upUrl, bytes.length);
        sendPdfFile(res, output, "reordered.pdf", [source, output]);

    } catch (err) {
        safeDelete(source); safeDelete(output);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- I. Delete Pages ---
app.post("/pdf/delete-pages", async (req, res) => {
    let source, output;
    try {
        const { publicUrl, pages } = req.body; // pages to DELETE: [1, 2]
        source = await downloadToTempFile(publicUrl);
        const pdf = await PDFDocument.load(fs.readFileSync(source));
        
        const toDelete = new Set((pages || []).map(p => p - 1));
        const count = pdf.getPageCount();
        
        // PDF-Lib removePage re-indexes, so safest is to create new doc keeping WANTED pages
        const newDoc = await PDFDocument.create();
        const keepIndices = [];
        for(let i=0; i<count; i++) {
            if(!toDelete.has(i)) keepIndices.push(i);
        }
        
        const copied = await newDoc.copyPages(pdf, keepIndices);
        copied.forEach(p => newDoc.addPage(p));

        const bytes = await newDoc.save();
        output = createTempFile("cleaned");
        fs.writeFileSync(output, bytes);
        
        const upUrl = await uploadBufferToSupabase(Buffer.from(bytes), "deleted_pages.pdf");
        await recordPdfOp(req, "delete-pages", upUrl, bytes.length);
        sendPdfFile(res, output, "cleaned.pdf", [source, output]);

    } catch (err) {
        safeDelete(source); safeDelete(output);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// =================================================================
// 🚀 3. SaaS Page Builder API (CRUD) 🚀
// =================================================================

// --- Landing Pages ---

app.get("/saas/landing-pages", async (req, res) => {
    const { data, error } = await supabase.from("landing_pages").select("*").eq("user_id", req.user.id);
    if(error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, pages: data });
});

app.post("/saas/landing-page", async (req, res) => {
  try {
    const { title, description, primaryColor, rawBase64Image, ctaLink, features } = req.body;
    let finalBase64Uri = null;

    if (rawBase64Image) finalBase64Uri = await optimizeBase64Image(rawBase64Image);

    const htmlContent = generateLandingPageHtml({ 
        title, description, primaryColor, imageUrl: finalBase64Uri, ctaLink, features 
    });

    const pageSlug = `lp-${Date.now()}`;
    const finalUrl = await deployHtmlToCloudflare(htmlContent, pageSlug);

    const { data, error } = await supabase.from("landing_pages").insert([{
      user_id: req.user.id,
      title, description, url: finalUrl, slug: pageSlug,
      config: req.body
    }]).select();

    if(error) throw error;
    await saveLog("create-landing-page", req, { url: finalUrl });

    res.json({ ok: true, url: finalUrl, id: data[0].id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/saas/landing-page/:id", async (req, res) => {
    const { error } = await supabase.from("landing_pages").delete().eq("id", req.params.id).eq("user_id", req.user.id);
    if(error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, message: "Deleted from DB. (Note: Cloudflare deployment remains until overwritten)" });
});

// --- Bio Pages ---

app.get("/saas/bio-pages", async (req, res) => {
    // Also fetch links?
    const { data, error } = await supabase.from("bio_pages").select("*, bio_links(*)").eq("user_id", req.user.id);
    if(error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, pages: data });
});

app.post("/saas/bio-page", async (req, res) => {
  try {
    const { name, bio, rawBase64Image, links, themeColor } = req.body;
    let finalBase64Uri = null;

    if (rawBase64Image) finalBase64Uri = await optimizeBase64Image(rawBase64Image);

    const htmlContent = generateBioPageHtml({ name, bio, profileImageUrl: finalBase64Uri, links, themeColor });
    const pageSlug = `bio-${Date.now()}`;
    const finalUrl = await deployHtmlToCloudflare(htmlContent, pageSlug);

    // Save Page
    const { data: pageData, error: pageError } = await supabase.from("bio_pages").insert([{
      user_id: req.user.id, name, bio, url: finalUrl, slug: pageSlug, config: req.body
    }]).select();

    if(pageError) throw pageError;
    const pageId = pageData[0].id;

    // Save Links
    if(links && links.length > 0) {
        const linkRows = links.map(l => ({ bio_page_id: pageId, text: l.text, url: l.url, color: l.color }));
        await supabase.from("bio_links").insert(linkRows);
    }

    await saveLog("create-bio-page", req, { url: finalUrl });
    res.json({ ok: true, url: finalUrl, id: pageId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/saas/bio-page/:id", async (req, res) => {
    // Cascade delete handles links if configured in SQL, otherwise delete manually
    await supabase.from("bio_links").delete().eq("bio_page_id", req.params.id);
    const { error } = await supabase.from("bio_pages").delete().eq("id", req.params.id).eq("user_id", req.user.id);
    
    if(error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, message: "Bio Page deleted." });
});

// =================================================================
// 🚀 Run Server 🚀
// =================================================================

app.listen(PORT, () => {
  console.log(`✅ PDF SaaS v2 Running on port ${PORT}`);
});

export default app;

/*
=================================================================
📘 DATABASE SETUP (SQL) 📘
Run these commands in Supabase SQL Editor to create the tables.
=================================================================

-- 1. Users Table (API Keys & Plans)
CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  plan TEXT CHECK (plan IN ('free', 'pro')) DEFAULT 'free',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Logs Table (Audit Trail)
CREATE TABLE logs (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  action TEXT,
  user_id UUID REFERENCES users(id),
  ip TEXT,
  endpoint TEXT,
  extra JSONB
);

-- 3. PDF Files Table (History)
CREATE TABLE pdf_files (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  user_id UUID REFERENCES users(id),
  action TEXT,
  url TEXT,
  size_bytes BIGINT,
  metadata JSONB
);

-- 4. Landing Pages
CREATE TABLE landing_pages (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  user_id UUID REFERENCES users(id),
  title TEXT,
  description TEXT,
  url TEXT,
  slug TEXT,
  config JSONB
);

-- 5. Bio Pages
CREATE TABLE bio_pages (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  user_id UUID REFERENCES users(id),
  name TEXT,
  bio TEXT,
  url TEXT,
  slug TEXT,
  config JSONB
);

-- 6. Bio Links
CREATE TABLE bio_links (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  bio_page_id BIGINT REFERENCES bio_pages(id) ON DELETE CASCADE,
  text TEXT,
  url TEXT,
  color TEXT
);

-- Insert a Demo User to start
INSERT INTO users (email, api_key, plan) VALUES 
('admin@saas.com', 'demo-key-123', 'pro');

=================================================================
🚀 HOW TO RUN 🚀
=================================================================

1. Prerequisites:
   - Node.js v18+
   - "type": "module" in package.json
   - Dependencies: npm install express axios cors pdf-lib pdf-parse @supabase/supabase-js sharp express-rate-limit form-data

2. Start Server:
   node index.js

3. Usage Examples (Headers: x-api-key: demo-key-123):

   > Check Health:
   GET http://localhost:3000/health

   > Compress PDF:
   POST http://localhost:3000/pdf/compress
   Body: { "publicUrl": "https://..." }

   > Create Landing Page:
   POST http://localhost:3000/saas/landing-page
   Body: { 
     "title": "My SaaS", 
     "description": "Best PDF tools", 
     "rawBase64Image": "data:image/png;base64,..." 
   }

*/
