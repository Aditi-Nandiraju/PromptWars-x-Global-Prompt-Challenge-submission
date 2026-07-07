const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Path to persistent complaints store
const COMPLAINTS_FILE = path.join(__dirname, 'data', 'complaints.json');
const SERVICES_FILE = path.join(__dirname, 'services.json');

// In-memory session memory for chat: stores last 5 messages per session_id
const chatSessions = {};

// Helper: Read complaints from file
function readComplaints() {
  try {
    if (!fs.existsSync(COMPLAINTS_FILE)) {
      fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify([]));
      return [];
    }
    const data = fs.readFileSync(COMPLAINTS_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Error reading complaints:', err);
    return [];
  }
}

// Helper: Write complaints to file
function writeComplaints(complaints) {
  try {
    const dir = path.dirname(COMPLAINTS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify(complaints, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing complaints:', err);
  }
}

// Helper: Read services seed data
function readServices() {
  try {
    if (!fs.existsSync(SERVICES_FILE)) {
      return [];
    }
    const data = fs.readFileSync(SERVICES_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Error reading services:', err);
    return [];
  }
}

// Language Detection Utility (based on Unicode blocks)
function detectLanguage(text) {
  if (!text) return 'English';
  // Devanagari block (Hindi): U+0900 to U+097F
  if (/[\u0900-\u097F]/.test(text)) return 'Hindi';
  // Tamil block: U+0B80 to U+0BFF
  if (/[\u0B80-\u0BFF]/.test(text)) return 'Tamil';
  // Fallback to English
  return 'English';
}

// ----------------------------------------------------
// LOCAL LLM (Ollama) INTEGRATION
// ----------------------------------------------------
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
let ollamaAvailable = false;

// Checked once at startup so we can log a clear message instead of crashing
// when Ollama isn't running; per-request calls still fall back to mocks below.
async function checkOllamaAvailability() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`status ${response.status}`);

    const data = await response.json();
    const models = (data.models || []).map(m => m.name);
    ollamaAvailable = true;
    console.log(`Ollama is reachable at ${OLLAMA_BASE_URL}`);
    if (!models.some(m => m.startsWith(OLLAMA_MODEL.split(':')[0]))) {
      console.warn(`Model "${OLLAMA_MODEL}" was not found in Ollama. Run: ollama pull ${OLLAMA_MODEL}`);
    }
  } catch (err) {
    ollamaAvailable = false;
    console.error(`\nOllama not running — start it with \`ollama serve\` (and run \`ollama pull ${OLLAMA_MODEL}\` if you haven't already).\n/chat and /simplify-document will use offline fallback responses until Ollama is available.\n`);
  }
}

// Call local Ollama server using fetch
async function callOllama(prompt, isJson = false) {
  const payload = {
    model: OLLAMA_MODEL,
    prompt,
    stream: false
  };
  if (isJson) {
    payload.format = 'json';
  }

  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama API failed with status ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const text = data.response;
  if (!text) throw new Error('Empty response from Ollama API');
  return text;
}

// ----------------------------------------------------
// LOCAL EMBEDDINGS (@xenova/transformers) INTEGRATION
// Used for /recommend-service and /report-issue category matching.
// Runs fully in-process (WASM/ONNX) — no external server or API key.
// ----------------------------------------------------
const EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
let embedderPromise = null;

function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      return pipeline('feature-extraction', EMBEDDING_MODEL);
    })();
  }
  return embedderPromise;
}

async function embedText(text) {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// Vectors from embedText() are already normalized, so the dot product IS the cosine similarity.
function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ----------------------------------------------------
// LOCAL COMPLAINT TRIAGE (embedding category match + rule-based urgency)
// Used by /report-issue instead of an LLM call.
// ----------------------------------------------------
// English, Hindi, and Tamil phrases per category — same-language similarity is far more
// reliable than cross-lingual for this model, so descriptions in any of the three match well.
const COMPLAINT_CATEGORY_EXAMPLES = {
  roads: [
    "There is a big pothole in the middle of the road",
    "The road surface is cracked and damaged",
    "Street pavement is broken and dangerous for vehicles",
    "सड़क के बीचोबीच एक बड़ा गड्ढा है",
    "சாலையில் பெரிய குழி உள்ளது"
  ],
  water: [
    "There is no water supply in my area",
    "A water pipeline is leaking on the street",
    "Drinking water quality is poor and contaminated",
    "Dirty water is overflowing from a broken pipe onto the road",
    "मेरे इलाके में पानी की आपूर्ति नहीं है",
    "எங்கள் பகுதியில் தண்ணீர் வரவில்லை"
  ],
  electricity: [
    "The electricity has been out for a long time",
    "Power lines are sparking and dangerous",
    "Streetlights are not working at night",
    "बिजली बहुत देर से नहीं आ रही है",
    "மின்சாரம் நீண்ட நேரமாக இல்லை"
  ],
  sanitation: [
    "Garbage has not been collected for days and is piling up on the street",
    "Household waste and trash bins are overflowing in the neighborhood",
    "Public area is unhygienic due to uncollected solid waste",
    "कचरा उठाया नहीं गया है और जमा हो रहा है",
    "குப்பை அகற்றப்படாமல் குவிந்துள்ளது"
  ],
  other: [
    "There is illegal construction happening in my neighborhood",
    "Stray animals are causing a public nuisance",
    "General complaint about civic administration",
    "मेरे इलाके में अवैध निर्माण हो रहा है",
    "எனது பகுதியில் சட்டவிரோத கட்டுமானம் நடக்கிறது"
  ]
};

let categoryEmbeddingsCache = null;
async function getCategoryEmbeddings() {
  if (categoryEmbeddingsCache) return categoryEmbeddingsCache;
  const result = {};
  for (const [cat, phrases] of Object.entries(COMPLAINT_CATEGORY_EXAMPLES)) {
    result[cat] = await Promise.all(phrases.map(embedText));
  }
  categoryEmbeddingsCache = result;
  return result;
}

// Classify complaint description into roads/water/electricity/sanitation/other by
// comparing its embedding against a small set of hardcoded example phrases per category.
async function classifyComplaintCategory(description) {
  const [descVec, categoryEmbeddings] = await Promise.all([
    embedText(description),
    getCategoryEmbeddings()
  ]);

  let bestCategory = 'other';
  let bestScore = -Infinity;
  for (const [cat, vecs] of Object.entries(categoryEmbeddings)) {
    const maxSim = Math.max(...vecs.map(v => cosineSimilarity(descVec, v)));
    if (maxSim > bestScore) {
      bestScore = maxSim;
      bestCategory = cat;
    }
  }
  return bestCategory;
}

const URGENCY_HIGH_KEYWORDS = ['sparking', 'danger', 'child', 'elderly', 'खतरा', 'बच्चा', 'बुजुर्ग', 'चिंगारी', 'ஆபத்து', 'குழந்தை', 'முதியவர்', 'தீப்பொறி'];
const URGENCY_MEDIUM_KEYWORDS = ['days', 'no water', 'leak', 'दिन', 'रिसाव', 'पानी नहीं', 'நாட்கள்', 'கசிவு', 'தண்ணீர் இல்லை'];

// Rule-based urgency scorer: keyword hits bump Low -> Medium -> High.
function scoreUrgency(description) {
  const text = description.toLowerCase();
  if (URGENCY_HIGH_KEYWORDS.some(k => text.includes(k))) return 'High';
  if (URGENCY_MEDIUM_KEYWORDS.some(k => text.includes(k))) return 'Medium';
  return 'Low';
}

// sanitation reuses the "garbage" department entry in mockData.complaintTriage
const CATEGORY_TO_TRIAGE_KEY = { sanitation: 'garbage' };
function getDeptInfoForCategory(category, lang) {
  const lData = mockData[lang] || mockData.English;
  const key = CATEGORY_TO_TRIAGE_KEY[category] || category;
  return lData.complaintTriage[key] || mockData.English.complaintTriage.other;
}

// ----------------------------------------------------
// MOCK FALLBACK UTILITY
// Handles multilingual mock content if Gemini API is missing or fails
// ----------------------------------------------------
const mockData = {
  English: {
    hello: "Hello! I am your Citizen Service Assistant. How can I help you today? You can ask me about government services, documents, or grievance tracking.",
    docSimplifyIntro: "This circular outlines the official guidelines and compliance requirements. We have simplified it for your convenience:",
    docNextSteps: [
      "Gather the necessary identity and address verification documents.",
      "Submit the applications either online on the portal or at your nearest service kiosk.",
      "Keep the generated application receipt for tracking purposes."
    ],
    complaintTriage: {
      roads: { dept: "Municipal Roads & Highways Division", time: "5 days" },
      water: { dept: "Water Supply & Sewage Board", time: "3 days" },
      electricity: { dept: "State Power Grid Corporation", time: "24 hours" },
      garbage: { dept: "Sanitation & Solid Waste Management", time: "2 days" },
      streetlights: { dept: "Municipal Electrical Works Department", time: "3 days" },
      illegal: { dept: "Town Planning & Land Encroachment Control", time: "10 days" },
      safety: { dept: "Local Civil Police & Vigilance", time: "1 day" },
      other: { dept: "General Grievance Cell", time: "7 days" }
    },
    serviceReasons: {
      "aadhaar-enrollment": "Aadhaar Card is recommended because you need a primary national identity and proof of address.",
      "pan-card": "A PAN Card is required for financial operations, tax registration, or opening a bank account.",
      "birth-certificate": "A Birth Certificate is the official document for registering a newborn child and obtaining legal identity.",
      "death-certificate": "A Death Certificate is required to settle legal affairs and close bank accounts of the deceased.",
      "marriage-certificate": "A Marriage Certificate is required to legally prove a marital relationship for visa, banking, or joint assets.",
      "voter-id": "A Voter ID is recommended to enroll in the electoral rolls and obtain a valid national photo ID.",
      "income-certificate": "An Income Certificate is required to apply for fee concessions, education scholarships, or state subsidies.",
      "caste-certificate": "A Caste Certificate is required to access educational reservations or caste-based government welfare benefits.",
      "domicile-certificate": "A Domicile Certificate proves state residence, which is required for local jobs and college reservations.",
      "ration-card": "A Ration Card is recommended to get subsidized food grains and establish household proof.",
      "disability-certificate": "A UDID Disability Certificate is required to claim reservations, transport concessions, and special schemes.",
      "pension-schemes": "Pension schemes are recommended to secure monthly financial welfare for senior citizens, widows, or disabled individuals.",
      "water-connection": "Water connection service is recommended to request a new water pipe connection or resolve leakages.",
      "electricity-connection": "Electricity connection service is recommended to request a new energy meter or report billing problems.",
      "property-tax": "Property Tax assessment is required to calculate and pay annual property liabilities online.",
      "trade-license": "A Trade License is required to legally operate a commercial retail shop or business in municipal zones.",
      "driving-license": "A Driving License is recommended to legally drive motor vehicles or renew an expired permit.",
      "vehicle-registration": "A Vehicle RC is required to legally register a newly purchased car or motorcycle.",
      "ayushman-bharat": "Ayushman Bharat health insurance is recommended to obtain up to Rs. 5 Lakhs of free medical coverage.",
      "student-scholarship": "Student scholarships are recommended to get financial aid for school or college expenses."
    }
  },
  Hindi: {
    hello: "नमस्ते! मैं आपका नागरिक सेवा सहायक हूँ। मैं आज आपकी क्या सहायता कर सकता हूँ? आप सरकारी सेवाओं, दस्तावेज़ों या शिकायत ट्रैकिंग के बारे में पूछ सकते हैं।",
    docSimplifyIntro: "यह परिपत्र आधिकारिक दिशानिर्देशों और अनुपालन आवश्यकताओं को रेखांकित करता है। हमने इसे आपकी सुविधा के लिए सरल बना दिया है:",
    docNextSteps: [
      "आवश्यक पहचान और पते के सत्यापन दस्तावेज़ों को एकत्र करें।",
      "आवेदन को ऑनलाइन पोर्टल पर या अपने नजदीकी नागरिक सेवा केंद्र पर जमा करें।",
      "ट्रैकिंग उद्देश्यों के लिए जनरेट की गई आवेदन रसीद को सुरक्षित रखें।"
    ],
    complaintTriage: {
      roads: { dept: "नगर निगम सड़क एवं लोक निर्माण विभाग", time: "5 दिन" },
      water: { dept: "जल आपूर्ति एवं सीवरेज बोर्ड", time: "3 दिन" },
      electricity: { dept: "राज्य विद्युत वितरण निगम लिमिटेड", time: "24 घंटे" },
      garbage: { dept: "सफाई एवं ठोस कचरा प्रबंधन विभाग", time: "2 दिन" },
      streetlights: { dept: "नगर निगम विद्युत कार्य विभाग", time: "3 दिन" },
      illegal: { dept: "नगर नियोजन एवं भूमि अतिक्रमण नियंत्रण", time: "10 दिन" },
      safety: { dept: "स्थानीय नागरिक पुलिस और सतर्कता", time: "1 दिन" },
      other: { dept: "सामान्य शिकायत प्रकोष्ठ", time: "7 दिन" }
    },
    serviceReasons: {
      "aadhaar-enrollment": "आधार कार्ड की सिफारिश की जाती है क्योंकि आपको एक प्राथमिक राष्ट्रीय पहचान और पते के प्रमाण की आवश्यकता है।",
      "pan-card": "वित्तीय लेनदेन, कर पंजीकरण, या बैंक खाता खोलने के लिए पैन कार्ड की आवश्यकता होती है।",
      "birth-certificate": "नवजात शिशु के पंजीकरण और कानूनी पहचान प्राप्त करने के लिए जन्म प्रमाण पत्र एक आधिकारिक दस्तावेज है।",
      "death-certificate": "मृतक के कानूनी मामलों को निपटाने और बैंक खातों को बंद करने के लिए मृत्यु प्रमाण पत्र की आवश्यकता होती है।",
      "marriage-certificate": "वीजा, बैंकिंग, या संयुक्त संपत्ति के लिए कानूनी रूप से वैवाहिक संबंध साबित करने के लिए विवाह प्रमाण पत्र की आवश्यकता होती है।",
      "voter-id": "मतदाता सूची में नाम दर्ज कराने और वैध राष्ट्रीय फोटो पहचान पत्र प्राप्त करने के लिए वोटर आईडी की सिफारिश की जाती है।",
      "income-certificate": "शुल्क छूट, शिक्षा छात्रवृत्ति, या राज्य सब्सिडी के लिए आवेदन करने के लिए आय प्रमाण पत्र की आवश्यकता होती है।",
      "caste-certificate": "शैक्षणिक आरक्षण या जाति-आधारित सरकारी कल्याणकारी लाभों का लाभ उठाने के लिए जाति प्रमाण पत्र की आवश्यकता होती है।",
      "domicile-certificate": "मूल निवास प्रमाण पत्र राज्य की नागरिकता साबित करता है, जो स्थानीय नौकरियों और कॉलेज आरक्षण के लिए आवश्यक है।",
      "ration-card": "सब्सिडी वाले खाद्यान्न प्राप्त करने और परिवार का प्रमाण स्थापित करने के लिए राशन कार्ड की सिफारिश की जाती है।",
      "disability-certificate": "आरक्षण, परिवहन छूट और विशेष योजनाओं का दावा करने के लिए यूडीआईडी विकलांगता प्रमाण पत्र की आवश्यकता होती है।",
      "pension-schemes": "वरिष्ठ नागरिकों, विधवाओं या विकलांग व्यक्तियों के लिए मासिक वित्तीय कल्याण सुनिश्चित करने के लिए पेंशन योजनाओं की सिफारिश की जाती है।",
      "water-connection": "एक नया पानी का नल कनेक्शन लगाने या पानी के रिसाव को हल करने के लिए जल कनेक्शन सेवा की सिफारिश की जाती है।",
      "electricity-connection": "नया बिजली मीटर लगवाने या बिलिंग समस्याओं की रिपोर्ट करने के लिए बिजली कनेक्शन सेवा की सिफारिश की जाती है।",
      "property-tax": "वार्षिक संपत्ति कर की गणना और ऑनलाइन भुगतान करने के लिए संपत्ति कर मूल्यांकन की आवश्यकता होती है।",
      "trade-license": "नगर निगम क्षेत्रों में कानूनी रूप से व्यावसायिक खुदरा दुकान या व्यवसाय संचालित करने के लिए ट्रेड लाइसेंस की आवश्यकता होती है।",
      "driving-license": "कानूनी रूप से मोटर वाहन चलाने या समाप्त हो चुके परमिट को नवीनीकृत करने के लिए ड्राइविंग लाइसेंस की सिफारिश की जाती है।",
      "vehicle-registration": "नवनिर्मित कार या मोटरसाइकिल को कानूनी रूप से पंजीकृत करने के लिए वाहन आरसी की आवश्यकता होती है।",
      "ayushman-bharat": "रु. 5 लाख तक का मुफ्त चिकित्सा उपचार प्राप्त करने के लिए आयुष्मान भारत स्वास्थ्य बीमा की सिफारिश की जाती है।",
      "student-scholarship": "स्कूल या कॉलेज के खर्चों के लिए वित्तीय सहायता प्राप्त करने के लिए छात्र छात्रवृत्ति की सिफारिश की जाती है।"
    }
  },
  Tamil: {
    hello: "வணக்கம்! நான் உங்கள் குடிமக்கள் சேவை உதவியாளர். உங்களுக்கு நான் எவ்வாறு உதவ முடியும்? நீங்கள் அரசு சேவைகள், ஆவணங்கள் அல்லது புகார்கள் பற்றி கேட்கலாம்.",
    docSimplifyIntro: "இந்த சுற்றறிக்கை அதிகாரப்பூர்வ வழிகாட்டுதல்களையும் இணக்கத் தேவைகளையும் விளக்குகிறது. உங்கள் வசதிக்காக இதை எளிமையாக்கியுள்ளோம்:",
    docNextSteps: [
      "தேவையான அடையாள மற்றும் முகவரி சரிபார்ப்பு ஆவணங்களை சேகரிக்கவும்.",
      "விண்ணப்பங்களை ஆன்லைனிலோ அல்லது உங்கள் அருகிலுள்ள சேவை மையத்திலோ சமர்ப்பிக்கவும்.",
      "விண்ணப்பத்தை கண்காணிக்க வழங்கப்பட்ட ரசீதை பாதுகாப்பாக வைக்கவும்."
    ],
    complaintTriage: {
      roads: { dept: "மாநகராட்சி சாலை மற்றும் நெடுஞ்சாலைத் துறை", time: "5 நாட்கள்" },
      water: { dept: "குடிநீர் வழங்கல் மற்றும் கழிவுநீரகற்று வாரியம்", time: "3 நாட்கள்" },
      electricity: { dept: "மாநில மின்சார வாரியம்", time: "24 மணி நேரம்" },
      garbage: { dept: "சுகாதாரம் மற்றும் திடக்கழிவு மேலாண்மை துறை", time: "2 நாட்கள்" },
      streetlights: { dept: "மாநகராட்சி மின்சாரப் பணிகள் துறை", time: "3 நாட்கள்" },
      illegal: { dept: "நகர அமைப்பு மற்றும் நில ஆக்கிரமிப்பு தடுப்பு பிரிவு", time: "10 நாட்கள்" },
      safety: { dept: "உள்ளூர் காவல் மற்றும் பொது பாதுகாப்பு பிரிவு", time: "1 நாள்" },
      other: { dept: "பொது குறைதீர்க்கும் பிரிவு", time: "7 நாட்கள்" }
    },
    serviceReasons: {
      "aadhaar-enrollment": "முகவரி மற்றும் அடையாளத்திற்கான முதன்மை ஆவணமாக இருப்பதால் ஆதார் அட்டை பரிந்துரைக்கப்படுகிறது.",
      "pan-card": "நிதி பரிவர்த்தனைகள், வரி பதிவு அல்லது வங்கி கணக்கு தொடங்க பான் கார்டு தேவைப்படுகிறது.",
      "birth-certificate": "குழந்தையின் பிறப்பை பதிவு செய்து சட்டப்பூர்வ அடையாளத்தைப் பெற பிறப்பு சான்றிதழ் அவசியம்.",
      "death-certificate": "இறந்தவரின் சட்டப்பூர்வ காரியங்களை முடிக்க மற்றும் வங்கி கணக்குகளை மூட இறப்பு சான்றிதழ் தேவை.",
      "marriage-certificate": "விசா, வங்கி அல்லது கூட்டு சொத்துக்களுக்கு திருமணத்தை சட்டப்பூர்வமாக நிரூபிக்க திருமண சான்றிதழ் தேவை.",
      "voter-id": "வாக்காளர் பட்டியலில் சேரவும், செல்லுபடியாகும் புகைப்பட அடையாள அட்டை பெறவும் வாக்காளர் அடையாள அட்டை பரிந்துரைக்கப்படுகிறது.",
      "income-certificate": "கட்டண சலுகை, கல்வி உதவித்தொகை அல்லது அரசு மானியங்களுக்கு விண்ணப்பிக்க வருமான சான்றிதழ் தேவை.",
      "caste-certificate": "கல்வி இடஒதுக்கீடு அல்லது சாதி அடிப்படையிலான அரசு நலத்திட்டங்களை பெற சாதி சான்றிதழ் தேவை.",
      "domicile-certificate": "உள்ளூர் வேலைகள் மற்றும் கல்லூரி இடஒதுக்கீட்டிற்கு தேவையான மாநில இருப்பிட சான்றிதழ் இதுவாகும்.",
      "ration-card": "மானிய விலையில் உணவு தானியங்களைப் பெறவும், குடும்ப முகவரி சான்றாகவும் குடும்ப அட்டை பரிந்துரைக்கப்படுகிறது.",
      "disability-certificate": "இடஒதுக்கீடு, பயணச் சலுகைகள் மற்றும் சிறப்புத் திட்டங்களைப் பெற மாற்றுத்திறனாளி சான்றிதழ் (UDID) தேவை.",
      "pension-schemes": "முதியவர்கள், விதவைகள் அல்லது மாற்றுத்திறனாளிகளுக்கு மாதாந்திர நிதியுதவி கிடைக்க ஓய்வூதியத் திட்டங்கள் பரிந்துரைக்கப்படுகின்றன.",
      "water-connection": "புதிய குடிநீர் இணைப்பு பெற அல்லது கசிவுகளை சரிசெய்ய குடிநீர் இணைப்பு சேவை பரிந்துரைக்கப்படுகிறது.",
      "electricity-connection": "புதிய மின்சார மீட்டர் பெற அல்லது மின் கட்டண புகார்களுக்கு மின்சார இணைப்பு சேவை பரிந்துரைக்கப்படுகிறது.",
      "property-tax": "ஆண்டு சொத்து வரியை கணக்கிட்டு ஆன்லைனில் செலுத்த சொத்து வரி மதிப்பீடு தேவை.",
      "trade-license": "வணிக ரீதியான கடை அல்லது தொழிலை சட்டப்பூர்வமாக நடத்த வணிக உரிமம் (Trade License) தேவை.",
      "driving-license": "சட்டப்பூர்வமாக வாகனம் ஓட்ட அல்லது காலாவதியான உரிமத்தை புதுப்பிக்க ஓட்டுநர் உரிமம் பரிந்துரைக்கப்படுகிறது.",
      "vehicle-registration": "புதிதாக வாங்கிய வாகனம் அல்லது மோட்டார் சைக்கிளை சட்டப்பூர்வமாக பதிவு செய்ய வாகன பதிவு சான்றிதழ் (RC) தேவை.",
      "ayushman-bharat": "ரூ. 5 லட்சம் வரையிலான இலவச மருத்துவ காப்பீடு பெற ஆயுஷ்மான் பாரத் காப்பீட்டுத் திட்டம் பரிந்துரைக்கப்படுகிறது.",
      "student-scholarship": "பள்ளி அல்லது கல்லூரி செலவுகளுக்கு நிதியுதவி பெற கல்வி உதவித்தொகை திட்டங்கள் பரிந்துரைக்கப்படுகின்றன."
    }
  }
};

// ----------------------------------------------------
// API ENDPOINTS
// ----------------------------------------------------

// Cache of {id, name, vec} per service, computed lazily on first request
let serviceEmbeddingsCache = null;
// Cross-lingual similarity (e.g. Tamil query vs English service text) is much weaker
// than same-language similarity for this model, so each service is embedded once per
// language it has localized text for, and matching takes the max similarity across variants.
async function getServiceEmbeddings() {
  if (serviceEmbeddingsCache) return serviceEmbeddingsCache;
  const services = readServices();
  serviceEmbeddingsCache = await Promise.all(services.map(async svc => {
    const texts = [`${svc.name}. ${svc.short_description}`];
    for (const langKey of ['Hindi', 'Tamil']) {
      const reason = mockData[langKey]?.serviceReasons?.[svc.id];
      if (reason) texts.push(reason);
    }
    const vecs = await Promise.all(texts.map(embedText));
    return { id: svc.id, name: svc.name, vecs };
  }));
  return serviceEmbeddingsCache;
}

// Raw cosine similarity baselines shift a lot by language (same-language text scores much
// higher than cross-lingual), so matching uses a per-request z-score instead of an absolute cutoff.
const SERVICE_MATCH_Z_THRESHOLD = 1.0;

// 1. POST /recommend-service
app.post('/recommend-service', async (req, res) => {
  const { situation } = req.body;
  if (!situation) {
    return res.status(400).json({ error: "Missing situation description" });
  }

  const lang = detectLanguage(situation);

  console.log(`\n=== Recommend Service Request ===`);
  console.log(`Input: "${situation}"`);
  console.log(`Detected Language: ${lang}`);

  // Cybercrime/fraud reports are out of scope for this services database, but embeddings tend to
  // conflate "hacked bank account" with PAN/banking services. Route these before scoring services.
  const textLower = situation.toLowerCase();
  if (textLower.includes('cyber') || textLower.includes('crime') || textLower.includes('cybercrime') || textLower.includes('scam') || textLower.includes('hack') || textLower.includes('fraud')) {
    console.log(`[Recommender] Detected cybercrime keywords. Providing helper response without embedding match.`);
    const cyberReason = lang === 'Hindi' ?
      "साइबर अपराध की रिपोर्ट करने के लिए, आप हमारे शिकायत निवारण पोर्टल पर 'सार्वजनिक सुरक्षा / उपद्रव' या 'अन्य' श्रेणी के तहत शिकायत दर्ज कर सकते हैं, या सीधे राष्ट्रीय साइबर अपराध हेल्पलाइन (1930) या cybercrime.gov.in पर संपर्क कर सकते हैं।" :
      lang === 'Tamil' ?
      "சைபர் குற்றங்களைப் புகாரளிக்க, எங்கள் குறைதீர்க்கும் போர்ட்டலில் 'பொது பாதுகாப்பு' அல்லது 'இதர' பிரிவின் கீழ் நீங்கள் புகார் அளிக்கலாம், அல்லது நேரடியாக தேசிய சைபர் குற்ற உதவி எண் (1930) அல்லது cybercrime.gov.in ஐ தொடர்பு கொள்ளலாம்." :
      "To report a cybercrime, you can submit a grievance on our portal under the 'Public safety / nuisance' or 'Other' category, or contact the official National Cyber Crime Reporting Portal helpline (1930) at cybercrime.gov.in directly.";

    return res.json({
      detected_language: lang,
      recommendations: [
        {
          id: "grievance-other",
          name: lang === 'Hindi' ? "सार्वजनिक सुरक्षा और अन्य शिकायतें" : lang === 'Tamil' ? "பொது பாதுகாப்பு மற்றும் இதர புகார்கள்" : "Public Safety & Grievance Reporting",
          reason: cyberReason
        }
      ]
    });
  }

  try {
    const [situationVec, serviceEmbeddings] = await Promise.all([
      embedText(situation),
      getServiceEmbeddings()
    ]);

    const scored = serviceEmbeddings
      .map(se => ({ id: se.id, name: se.name, similarity: Math.max(...se.vecs.map(v => cosineSimilarity(situationVec, v))) }))
      .sort((a, b) => b.similarity - a.similarity);

    const mean = scored.reduce((sum, s) => sum + s.similarity, 0) / scored.length;
    const variance = scored.reduce((sum, s) => sum + (s.similarity - mean) ** 2, 0) / scored.length;
    const stdDev = Math.sqrt(variance) || 1e-6;

    console.log(`[Recommender] Similarity scores:`, scored.map(s => `${s.id}=${s.similarity.toFixed(3)} (z=${((s.similarity - mean) / stdDev).toFixed(2)})`).join(', '));

    var finalMatches = scored
      .filter(s => (s.similarity - mean) / stdDev >= SERVICE_MATCH_Z_THRESHOLD)
      .slice(0, 3)
      .map(s => ({ id: s.id, name: s.name }));
  } catch (err) {
    console.error(`[Recommender] Embedding-based matching failed:`, err.message);
    return res.status(500).json({ error: "Recommendation engine unavailable", detail: err.message });
  }

  // Attach localized reasons (embeddings only tell us *which* service matches, not the explanation text)
  const lData = mockData[lang] || mockData.English;
  finalMatches = finalMatches.map(m => ({
    id: m.id,
    name: m.name,
    reason: lData.serviceReasons[m.id] || mockData.English.serviceReasons[m.id]
  }));

  if (finalMatches.length === 0) {
    console.log(`[Recommender] No services matched the query.`);
  }

  console.log(`[Recommender] Final returned matches:`, finalMatches);

  res.json({
    detected_language: lang,
    recommendations: finalMatches
  });
});

// 2. POST /chat
app.post('/chat', async (req, res) => {
  const { session_id, message, selected_service_id } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Missing message" });
  }

  const sessionId = session_id || 'default-session';
  const lang = detectLanguage(message);

  // Initialize session memory if empty
  if (!chatSessions[sessionId]) {
    chatSessions[sessionId] = [];
  }

  // Get service context if applicable
  let serviceContext = "";
  if (selected_service_id) {
    const services = readServices();
    const svc = services.find(s => s.id === selected_service_id);
    if (svc) {
      serviceContext = `The user is currently looking at the service: "${svc.name}" (Category: ${svc.category}, Eligibility: ${svc.eligibility}, Required Documents: ${svc.required_documents.join(', ')}). `;
    }
  }

  // Retrieve last 5 messages from session memory
  const history = chatSessions[sessionId].slice(-5);

  try {
    const formattedHistory = history.map(h => `${h.role === 'user' ? 'Citizen' : 'Assistant'}: ${h.text}`).join('\n');
    
    const prompt = `
      You are "Nagrik Seva Sahayak", a warm and helpful AI Companion for government services and citizen welfare.
      Always respond in the citizen's language. The current message is in: ${lang}. You MUST reply in ${lang}.
      
      ${serviceContext ? `Context details: ${serviceContext}` : ''}
      
      Here is the recent conversation history with this citizen:
      ${formattedHistory}

      Citizen's new message:
      "${message}"

      Reply to the citizen warmly, explaining things in very simple, plain language. Avoid bureaucratic jargon. List documents as bullet points if the user asks about procedures or requirements. Ensure your entire response is strictly in ${lang}.
    `;

    const assistantReply = await callOllama(prompt, false);

    // Save to session history
    chatSessions[sessionId].push({ role: 'user', text: message });
    chatSessions[sessionId].push({ role: 'assistant', text: assistantReply });

    res.json({
      detected_language: lang,
      session_id: sessionId,
      response: assistantReply
    });
  } catch (err) {
    console.warn(`[chat] Ollama unavailable or failed. Using fallback mock. Reason: ${err.message}`);
    
    // Multilingual mock conversation assistant
    const lData = mockData[lang] || mockData.English;
    let reply = lData.hello;

    // Simple keyword rules for mocked response
    const msgLower = message.toLowerCase();
    if (lang === 'Hindi') {
      if (msgLower.includes('दस्तावेज़') || msgLower.includes('कागज') || msgLower.includes('डॉक्यूमेंट')) {
        reply = "दस्तावेज़ों की सूची सेवा के अनुसार बदलती है। उदाहरण के लिए, नया आधार कार्ड बनवाने के लिए आपको मुख्य रूप से: \n• पते का प्रमाण (जैसे बिजली का बिल)\n• जन्मतिथि का प्रमाण (जैसे जन्म प्रमाण पत्र)\n• एक पासपोर्ट आकार के फोटो की आवश्यकता होगी।";
      } else if (msgLower.includes('शिकायत') || msgLower.includes('गड़बड़') || msgLower.includes('काम नहीं')) {
        reply = "आप हमारे 'शिकायत निवारण' पोर्टल पर सड़क, पानी, बिजली आदि की शिकायत दर्ज कर सकते हैं। शिकायत दर्ज करने के बाद, आपको एक ट्रैकिंग नंबर मिलेगा जिससे आप इसे ट्रैक कर सकते हैं।";
      } else if (selected_service_id) {
        reply = `आप अभी ${selected_service_id} सेवा के बारे में पूछ रहे हैं। ${lData.serviceReasons[selected_service_id] || "इसके लिए आपको अपने पहचान पत्र और पते के प्रमाण की आवश्यकता होगी।"}`;
      } else if (history.length > 0) {
        reply = `मैंने आपकी पिछली बात समझी। आपकी मदद के लिए, सरकारी सेवाओं या आवेदन पत्रों से जुड़े किसी भी सवाल को आप यहाँ साझा कर सकते हैं।`;
      }
    } else if (lang === 'Tamil') {
      if (msgLower.includes('ஆவணம்') || msgLower.includes('சான்றிதழ்') || msgLower.includes('டாக்குமெண்ட்')) {
        reply = "தேவைப்படும் ஆவணங்கள் சேவைக்கு ஏற்ப மாறுபடும். உதாரணமாக, ஆதார் அட்டைக்கு விண்ணப்பிக்க:\n• முகவரி சான்று (மின்சார கட்டணம் போன்றவை)\n• பிறந்த தேதி சான்று (பிறப்பு சான்றிதழ்)\n• சமீபத்திய புகைப்படங்கள் தேவைப்படும்.";
      } else if (msgLower.includes('புகார்') || msgLower.includes('பிரச்சனை') || msgLower.includes('தண்ணீர்')) {
        reply = "எங்கள் புகார் பிரிவில் குடிநீர் கசிவு, மின்சார தடை அல்லது சாலைப் பள்ளங்கள் பற்றிய புகாரைப் பதிவு செய்யலாம். பதிவுக்குப் பின் தங்களுக்கு ஒரு கண்காணிப்பு எண் வழங்கப்படும்.";
      } else if (selected_service_id) {
        reply = `நீங்கள் தற்போது ${selected_service_id} சேவை பற்றி வினவுகிறீர்கள். ${lData.serviceReasons[selected_service_id] || "இதற்கு உங்களது முகவரி மற்றும் அடையாளச் சான்று அவசியமாகும்."}`;
      } else if (history.length > 0) {
        reply = `உங்களது முந்தைய தகவலை நான் புரிந்து கொண்டேன். அரசு சேவைகள் மற்றும் விண்ணப்ப முறைகள் குறித்து ஏதேனும் கேள்விகள் இருந்தால் கேளுங்கள்.`;
      }
    } else {
      // English keyword mock
      if (msgLower.includes('document') || msgLower.includes('paper') || msgLower.includes('require')) {
        reply = "The required documents depend on the service. For example, Aadhaar enrollment requires:\n• Proof of Address (utility bill)\n• Proof of Date of Birth (school certificate)\n• Recent photo.";
      } else if (msgLower.includes('complaint') || msgLower.includes('grievance') || msgLower.includes('issue')) {
        reply = "You can report municipal grievances like leaking pipelines, power outages, and potholes under the Grievances tab. We will auto-triage it and give you a Tracking ID.";
      } else if (selected_service_id) {
        reply = `You are asking about ${selected_service_id}. ${lData.serviceReasons[selected_service_id] || "Please ensure you have valid identity and address documents ready."}`;
      } else if (history.length > 0) {
        reply = `I noted your previous queries. Let me know if you want to know about other schemes or eligibility details.`;
      }
    }

    // Save to session history
    chatSessions[sessionId].push({ role: 'user', text: message });
    chatSessions[sessionId].push({ role: 'assistant', text: reply });

    res.json({
      detected_language: lang,
      session_id: sessionId,
      response: reply
    });
  }
});

// 3. POST /simplify-document
app.post('/simplify-document', async (req, res) => {
  const { document_text } = req.body;
  if (!document_text) {
    return res.status(400).json({ error: "Missing document_text" });
  }

  const lang = detectLanguage(document_text);

  console.log(`\n=== Simplify Document Request ===`);
  console.log(`Detected Language: ${lang}`);
  console.log(`Input length: ${document_text.length} chars`);

  try {
    const prompt = `
      You are an expert at translating complex government notices, circulars, and laws into simple, plain language for common citizens.
      Analyze the following document text (which is in ${lang}):
      "${document_text}"

      Translate the core rules into easy-to-read language.
      Provide a plain-language explanation and a bulleted list of "what to do next" (Action Items).
      The entire explanation and checklist must be in ${lang}.

      Respond ONLY with a valid JSON object matching this schema:
      {
        "explanation": "A simple 2-3 sentence summary in ${lang}...",
        "action_items": [
          "Action item 1 in ${lang}",
          "Action item 2 in ${lang}",
          "Action item 3 in ${lang}"
        ]
      }
    `;

    console.log(`--- PROMPT SENT TO OLLAMA (model=${OLLAMA_MODEL}) ---`);
    console.log(prompt);
    console.log(`-----------------------------------------------------`);

    const rawResponse = await callOllama(prompt, true);

    console.log(`--- RAW RESPONSE FROM OLLAMA ---`);
    console.log(rawResponse);
    console.log(`--------------------------------`);

    const parsed = JSON.parse(rawResponse);
    console.log(`[simplify-document] LIVE Ollama path used.`);
    res.json({
      detected_language: lang,
      explanation: parsed.explanation,
      action_items: parsed.action_items
    });
  } catch (err) {
    console.warn(`[simplify-document] FALLBACK MOCK path used (Ollama unavailable or failed). Reason: ${err.message}`);

    const lData = mockData[lang] || mockData.English;
    res.json({
      detected_language: lang,
      explanation: lData.docSimplifyIntro + " " + document_text.substring(0, 100) + "...",
      action_items: lData.docNextSteps
    });
  }
});

// 4. POST /report-issue
app.post('/report-issue', async (req, res) => {
  const { category, description, location, citizen_name, citizen_contact } = req.body;
  if (!category || !description || !location) {
    return res.status(400).json({ error: "Missing category, description, or location" });
  }

  const lang = detectLanguage(description);
  
  // Classify category via local embeddings, then score urgency with keyword rules (no LLM call)
  let priority = "Low";
  let department = "Civic Grievance Cell";
  let resolutionTime = "5 days";

  try {
    const matchedCategory = await classifyComplaintCategory(description);
    const triageInfo = getDeptInfoForCategory(matchedCategory, lang);
    department = triageInfo.dept;
    resolutionTime = triageInfo.time;
  } catch (err) {
    console.warn(`[report-issue] Embedding category classification failed, using default department. Reason: ${err.message}`);
  }

  priority = scoreUrgency(description);

  // Create complaint entry
  const trackingId = `GRI-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
  const newComplaint = {
    id: trackingId,
    category,
    description,
    location,
    citizen_name: citizen_name || "Anonymous Citizen",
    citizen_contact: citizen_contact || "N/A",
    status: "Received",
    priority,
    department,
    resolution_time: resolutionTime,
    reported_at: new Date().toISOString(),
    updates: [
      {
        status: "Received",
        timestamp: new Date().toISOString(),
        comment: lang === 'Hindi' ? "शिकायत दर्ज की गई और संबंधित विभाग को भेजी गई।" :
                 lang === 'Tamil' ? "புகார் பதிவு செய்யப்பட்டு சம்பந்தப்பட்ட துறைக்கு அனுப்பப்பட்டது." :
                 "Grievance recorded and dispatched to the assigned department."
      }
    ]
  };

  // Persist to complaints database
  const complaints = readComplaints();
  complaints.push(newComplaint);
  writeComplaints(complaints);

  res.status(201).json({
    detected_language: lang,
    tracking_id: trackingId,
    complaint: newComplaint
  });
});

// 5. GET /complaints
app.get('/complaints', (req, res) => {
  res.json(readComplaints());
});

// 6. GET /complaint/:id
app.get('/complaint/:id', (req, res) => {
  const complaints = readComplaints();
  const complaint = complaints.find(c => c.id === req.params.id);
  if (!complaint) {
    return res.status(404).json({ error: "Complaint not found" });
  }
  res.json(complaint);
});

// 7. GET /stats (Aggregate complaints reporting metrics)
app.get('/stats', (req, res) => {
  const complaints = readComplaints();
  const total = complaints.length;

  const statusCounts = { Received: 0, "In Progress": 0, Resolved: 0 };
  const categoryCounts = {};
  let totalResolutionTimeDays = 0;
  let resolvedCount = 0;

  complaints.forEach(c => {
    // Status aggregates
    if (statusCounts[c.status] !== undefined) {
      statusCounts[c.status]++;
    } else {
      statusCounts[c.status] = 1;
    }

    // Category aggregates
    categoryCounts[c.category] = (categoryCounts[c.category] || 0) + 1;

    // Calculate resolution time if resolved
    if (c.status === 'Resolved') {
      resolvedCount++;
      // Parse resolution time (either mock or set) - default to 3 days if not parseable
      let days = 3; 
      const timeStr = c.resolution_time || '';
      const match = timeStr.match(/(\d+)\s*(day|hour|घंटे|दिन|நாள்)/i);
      if (match) {
        const val = parseInt(match[1]);
        const unit = match[2].toLowerCase();
        if (unit.includes('hour') || unit.includes('घंटे')) {
          days = val / 24;
        } else {
          days = val;
        }
      }
      totalResolutionTimeDays += days;
    }
  });

  const avgResolutionTime = resolvedCount > 0 ? (totalResolutionTimeDays / resolvedCount).toFixed(1) : "3.5";

  res.json({
    total_complaints: total,
    status_distribution: statusCounts,
    category_distribution: categoryCounts,
    avg_resolution_time_days: parseFloat(avgResolutionTime)
  });
});

// 8. POST /complaint/:id/update (controlled progression in demo)
app.post('/complaint/:id/update', (req, res) => {
  const { status, comment } = req.body;
  if (!status) {
    return res.status(400).json({ error: "Missing status field" });
  }

  const complaints = readComplaints();
  const index = complaints.findIndex(c => c.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: "Complaint not found" });
  }

  const current = complaints[index];
  current.status = status;
  current.updates.push({
    status: status,
    timestamp: new Date().toISOString(),
    comment: comment || `Status advanced to ${status}.`
  });

  complaints[index] = current;
  writeComplaints(complaints);

  res.json({
    message: "Complaint status updated successfully",
    complaint: current
  });
});

// Start Server
checkOllamaAvailability().finally(() => {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`Civic Assistant Platform running at http://localhost:${PORT}`);
    console.log(`Persistent Complaints database: ${COMPLAINTS_FILE}`);
    console.log(`====================================================`);
  });
});
