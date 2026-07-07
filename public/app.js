// State Management
const state = {
  sessionId: localStorage.getItem('civic_assistant_session_id') || `sess-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
  selectedServiceId: null,
  selectedServiceName: null,
  theme: localStorage.getItem('civic_assistant_theme') || 'light',
  complaints: []
};

// Save session ID
localStorage.setItem('civic_assistant_session_id', state.sessionId);

// DOM Elements
const elements = {
  navTabs: document.querySelectorAll('.nav-tab'),
  tabContents: document.querySelectorAll('.tab-content'),
  themeToggle: document.getElementById('theme-toggle'),
  
  // Service Finder
  btnFindServices: document.getElementById('btn-find-services'),
  serviceSearchInput: document.getElementById('service-search-input'),
  servicesResultsGrid: document.getElementById('services-results-grid'),
  recommendLangTag: document.getElementById('recommend-lang-tag'),
  resultsHeader: document.querySelector('.results-header'),
  quickTags: document.querySelectorAll('.quick-tag'),
  
  // Grievance Form
  grievanceForm: document.getElementById('grievance-form'),
  grievanceCategory: document.getElementById('grievance-category'),
  grievanceLocation: document.getElementById('grievance-location'),
  grievanceDescription: document.getElementById('grievance-description'),
  citizenName: document.getElementById('citizen-name'),
  citizenContact: document.getElementById('citizen-contact'),
  
  // Track & Stats
  statTotal: document.getElementById('stat-total'),
  statActive: document.getElementById('stat-active'),
  statResolved: document.getElementById('stat-resolved'),
  statTime: document.getElementById('stat-time'),
  lookupIdInput: document.getElementById('lookup-id-input'),
  btnLookup: document.getElementById('btn-lookup'),
  lookupResult: document.getElementById('lookup-result'),
  recentComplaintsList: document.getElementById('recent-complaints-list'),
  
  // Document Simplifier
  btnSimplify: document.getElementById('btn-simplify'),
  documentTextInput: document.getElementById('document-text-input'),
  simplifyResult: document.getElementById('simplify-result'),
  simplifiedExplanation: document.getElementById('simplified-explanation'),
  simplifiedActions: document.getElementById('simplified-actions'),
  simplifyLangTag: document.getElementById('simplify-lang-tag'),
  quickDocs: document.querySelectorAll('.quick-doc'),
  
  // AI Companion Chat
  chatMessages: document.getElementById('chat-messages'),
  chatInput: document.getElementById('chat-input'),
  btnChatSend: document.getElementById('btn-chat-send'),
  chatLangTag: document.getElementById('chat-lang-tag'),
  chatClear: document.getElementById('chat-clear'),
  chatServiceContext: document.getElementById('chat-service-context'),
  chatContextName: document.getElementById('chat-context-name'),
  btnClearChatContext: document.getElementById('btn-clear-chat-context')
};

// Set initial theme
document.body.setAttribute('data-theme', state.theme);
updateThemeIcon();

// ----------------------------------------------------
// THEME & NAVIGATION CONTROLS
// ----------------------------------------------------
elements.themeToggle.addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', state.theme);
  localStorage.setItem('civic_assistant_theme', state.theme);
  updateThemeIcon();
});

function updateThemeIcon() {
  const icon = elements.themeToggle.querySelector('i');
  if (state.theme === 'light') {
    icon.className = 'fa-solid fa-sun';
  } else {
    icon.className = 'fa-solid fa-moon';
  }
}

// Tab Switching
elements.navTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    // Remove active from all tabs
    elements.navTabs.forEach(t => t.classList.remove('active'));
    elements.tabContents.forEach(c => c.classList.remove('active'));
    
    // Add active to current
    tab.classList.add('active');
    const target = tab.getAttribute('data-target');
    document.getElementById(target).classList.add('active');

    // Trigger updates when entering specific tabs
    if (target === 'tab-track') {
      fetchStats();
      fetchComplaints();
    }
  });
});

// ----------------------------------------------------
// SERVICE FINDER CONTROLS
// ----------------------------------------------------

// Quick tag buttons helper
elements.quickTags.forEach(tag => {
  tag.addEventListener('click', () => {
    elements.serviceSearchInput.value = tag.getAttribute('data-text');
  });
});

elements.btnFindServices.addEventListener('click', async () => {
  const situation = elements.serviceSearchInput.value.trim();
  if (!situation) return;

  elements.servicesResultsGrid.innerHTML = `
    <div class="glass-panel" style="text-align: center; padding: 2rem;">
      <i class="fa-solid fa-spinner fa-spin text-primary" style="font-size: 2rem; margin-bottom: 1rem;"></i>
      <p>Analyzing your situation using Gemini and matching services...</p>
    </div>
  `;
  elements.resultsHeader.style.display = 'block';
  elements.recommendLangTag.style.display = 'none';

  try {
    const res = await fetch('/recommend-service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ situation })
    });
    const data = await res.json();
    
    // Show language transparency
    if (data.detected_language) {
      elements.recommendLangTag.innerText = `Responding in ${data.detected_language}`;
      elements.recommendLangTag.style.display = 'inline-block';
    }

    renderMatchedServices(data.recommendations || []);
  } catch (err) {
    elements.servicesResultsGrid.innerHTML = `
      <div class="glass-panel" style="text-align: center; color: var(--color-error); padding: 2rem;">
        <i class="fa-solid fa-triangle-exclamation" style="font-size: 2rem; margin-bottom: 1rem;"></i>
        <p>Error finding services. Please try again later.</p>
      </div>
    `;
    console.error(err);
  }
});

async function renderMatchedServices(recommendations) {
  if (recommendations.length === 0) {
    elements.servicesResultsGrid.innerHTML = `
      <div class="glass-panel" style="text-align: center; padding: 2rem;">
        <p>No directly matching services found. Try describing in different words.</p>
      </div>
    `;
    return;
  }

  // Fetch full details of all matched services to render checkboxes, eligibility
  try {
    // Read local database parameters (we can mock or fetch details based on recommendations)
    // The recommendations give us id and reasons. We can match them against local definitions.
    // We will hardcode the details locally in JavaScript to make rendering instant and reliable!
    const servicesDetails = {
      "aadhaar-enrollment": {
        category: "identity",
        documents: ["Proof of Address (Utility Bill, Passport)", "Proof of DOB (Birth Cert, School Book)", "Recent Photograph"],
        eligibility: "Resident of India (resided 182+ days in last 12 months)",
        time: "15-30 days"
      },
      "pan-card": {
        category: "identity",
        documents: ["Aadhaar Card (identity proof)", "Recent Photograph", "Address Proof"],
        eligibility: "All Indian citizens, business entities, and taxpayers",
        time: "10-15 days"
      },
      "birth-certificate": {
        category: "identity",
        documents: ["Hospital Discharge Slip / Signed Affidavit", "Parents' Identity Proof"],
        eligibility: "Parents of a newborn born within municipal limits",
        time: "7-10 days"
      },
      "death-certificate": {
        category: "identity",
        documents: ["Hospital Medical Certificate / Cremation Slip", "Identity Proof of the Deceased"],
        eligibility: "Family members of the deceased individual",
        time: "5-7 days"
      },
      "marriage-certificate": {
        category: "identity",
        documents: ["Age Proof of Bride & Groom", "Address Proof", "Marriage invitation/photos", "Witness ID"],
        eligibility: "Groom (age 21+) and Bride (age 18+) legally married",
        time: "15-30 days"
      },
      "voter-id": {
        category: "identity",
        documents: ["Age Proof (e.g. 10th marksheet)", "Address Proof", "Passport-size Photograph"],
        eligibility: "Indian citizens aged 18 or above on qualifying date",
        time: "30-45 days"
      },
      "income-certificate": {
        category: "welfare",
        documents: ["Salary Slip or Income Self-Declaration Affidavit", "Address Proof"],
        eligibility: "Residents needing to prove household income levels",
        time: "10-15 days"
      },
      "caste-certificate": {
        category: "welfare",
        documents: ["Family caste records (father's certificate)", "Address Proof"],
        eligibility: "Indian citizens belonging to SC, ST, or OBC categories",
        time: "15-20 days"
      },
      "domicile-certificate": {
        category: "welfare",
        documents: ["Utility Bill or Rent Agreement", "Ration Card or Aadhaar", "Residence proof (School certs)"],
        eligibility: "Living in the state/UT for a continuous specified period",
        time: "10-15 days"
      },
      "ration-card": {
        category: "welfare",
        documents: ["Family details & photographs", "Income Proof", "Address Proof"],
        eligibility: "Head of the family (oldest female member) living in state",
        time: "20-30 days"
      },
      "disability-certificate": {
        category: "welfare",
        documents: ["Medical Assessment Report from Govt Hospital", "Photograph", "Identity Proof"],
        eligibility: "Persons with a diagnosed disability of 40% or more",
        time: "30 days"
      },
      "pension-schemes": {
        category: "welfare",
        documents: ["Age Proof or Death certificate of spouse", "Income certificate", "Bank Passbook Copy"],
        eligibility: "Senior citizens, widows, or disabled individuals in poverty",
        time: "45-60 days"
      },
      "water-connection": {
        category: "utilities",
        documents: ["Property Ownership Proof (Sale Deed/Tax Receipt)", "Identity Proof"],
        eligibility: "Property owner or authorized tenant in supply zone",
        time: "15-20 days"
      },
      "electricity-connection": {
        category: "utilities",
        documents: ["Property Ownership Proof or Lease/NOC", "Identity Proof"],
        eligibility: "Property owner or lawful occupant of the premises",
        time: "7-10 days"
      },
      "property-tax": {
        category: "utilities",
        documents: ["Property Registration Documents", "Previous Year's Tax Receipt"],
        eligibility: "Property owners inside municipal limits",
        time: "Immediate (Online)"
      },
      "trade-license": {
        category: "utilities",
        documents: ["Shop Address Proof (Rent deed/tax bill)", "Identity Proof", "NOC if applicable"],
        eligibility: "Business owner starting operations in commercial zones",
        time: "15-30 days"
      },
      "driving-license": {
        category: "transport",
        documents: ["Age & Address Proof", "Medical Certificate (commercial/50+)", "Learner's License"],
        eligibility: "Citizens aged 18+ holding valid learner's permit",
        time: "20-30 days"
      },
      "vehicle-registration": {
        category: "transport",
        documents: ["Sale Certificate (Form 21)", "Insurance Copy", "PUC Certificate", "Identity Proof"],
        eligibility: "Owner of a motor vehicle purchased from authorized dealer",
        time: "15-20 days"
      },
      "ayushman-bharat": {
        category: "health/education",
        documents: ["Income Certificate or Ration Card", "Aadhaar Card", "Family listing details"],
        eligibility: "Low-income families identified under the SECC database",
        time: "7-15 days"
      },
      "student-scholarship": {
        category: "health/education",
        documents: ["Income Certificate", "Caste Certificate (if applicable)", "Academic Marksheets", "Bank Passbook"],
        eligibility: "Regular students in recognized institutions meeting criteria",
        time: "30-60 days"
      }
    };

    elements.servicesResultsGrid.innerHTML = '';
    recommendations.forEach(rec => {
      const details = servicesDetails[rec.id] || {
        category: "general",
        documents: ["Identity Proof", "Address Proof"],
        eligibility: "Citizen of India",
        time: "15 days"
      };

      const card = document.createElement('div');
      card.className = 'service-card';
      
      const docListHTML = details.documents.map(doc => `
        <div class="doc-item">
          <i class="fa-solid fa-circle-check"></i> <span>${doc}</span>
        </div>
      `).join('');

      card.innerHTML = `
        <div class="service-header-row">
          <h4 class="service-title">${rec.name}</h4>
          <span class="service-category">${details.category}</span>
        </div>
        <div class="reason-box">
          <i class="fa-solid fa-robot"></i> ${rec.reason}
        </div>
        <div class="doc-checklist">
          <div class="doc-checklist-title">Required Documents</div>
          ${docListHTML}
        </div>
        <div class="service-meta-row">
          <div class="meta-item">
            <span class="meta-label">Eligibility</span>
            <span class="meta-value">${details.eligibility}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Est. Processing Time</span>
            <span class="meta-value">${details.time}</span>
          </div>
        </div>
        <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem;">
          <button class="btn-primary btn-chat-context-trigger" data-id="${rec.id}" data-name="${rec.name}" style="flex: 1; padding: 0.5rem; font-size: 0.85rem;">
            <i class="fa-solid fa-comments"></i> Ask Companion About This
          </button>
        </div>
      `;

      // Set listener for chat context trigger
      card.querySelector('.btn-chat-context-trigger').addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const name = e.currentTarget.getAttribute('data-name');
        setChatContext(id, name);
      });

      elements.servicesResultsGrid.appendChild(card);
    });

  } catch (err) {
    console.error(err);
  }
}

function setChatContext(serviceId, serviceName) {
  state.selectedServiceId = serviceId;
  state.selectedServiceName = serviceName;
  elements.chatContextName.innerText = serviceName;
  elements.chatServiceContext.style.display = 'flex';
  
  // Automatically greet in chat about selected service
  appendChatMessage('assistant', `I see you are interested in **${serviceName}**. Ask me about the documents required, step-by-step procedures, or eligibility guidelines!`, 'English');
  elements.chatInput.focus();
}

elements.btnClearChatContext.addEventListener('click', () => {
  state.selectedServiceId = null;
  state.selectedServiceName = null;
  elements.chatServiceContext.style.display = 'none';
});

// ----------------------------------------------------
// GRIEVANCE REPORTING CONTROLS
// ----------------------------------------------------
elements.grievanceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const category = elements.grievanceCategory.value;
  const location = elements.grievanceLocation.value.trim();
  const description = elements.grievanceDescription.value.trim();
  const citizen_name = elements.citizenName.value.trim() || "Anonymous";
  const citizen_contact = elements.citizenContact.value.trim() || "N/A";

  const submitBtn = elements.grievanceForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Submitting & Triaging...`;

  try {
    const res = await fetch('/report-issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, location, description, citizen_name, citizen_contact })
    });
    
    if (res.status === 201) {
      const data = await res.json();
      alert(`Success! Complaint triaged.\nTracking ID: ${data.tracking_id}\nAssigned Dept: ${data.complaint.department}\nPriority: ${data.complaint.priority}`);
      
      // Reset form
      elements.grievanceForm.reset();
      
      // Jump to track tab and pre-fill tracking lookup
      elements.navTabs.forEach(t => {
        if (t.getAttribute('data-target') === 'tab-track') t.click();
      });
      elements.lookupIdInput.value = data.tracking_id;
      elements.btnLookup.click();
    } else {
      alert("Error reporting complaint. Check parameters.");
    }
  } catch (err) {
    alert("API connection failed.");
    console.error(err);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Submit Complaint & Triage`;
  }
});

// ----------------------------------------------------
// TRACK & STATS CONTROLS
// ----------------------------------------------------
async function fetchStats() {
  try {
    const res = await fetch('/stats');
    const data = await res.json();
    elements.statTotal.innerText = data.total_complaints;
    elements.statActive.innerText = (data.status_distribution["Received"] || 0) + (data.status_distribution["In Progress"] || 0);
    elements.statResolved.innerText = data.status_distribution["Resolved"] || 0;
    elements.statTime.innerText = `${data.avg_resolution_time_days} days`;
  } catch (e) {
    console.error('Error fetching stats:', e);
  }
}

async function fetchComplaints() {
  try {
    const res = await fetch('/complaints');
    const data = await res.json();
    state.complaints = data;
    renderComplaintsList(data);
  } catch (e) {
    console.error('Error fetching complaints:', e);
  }
}

function renderComplaintsList(complaints) {
  elements.recentComplaintsList.innerHTML = '';
  
  if (complaints.length === 0) {
    elements.recentComplaintsList.innerHTML = `<p class="placeholder-text" style="margin-top: 1rem;">No complaints filed yet.</p>`;
    return;
  }

  // Render recent first
  [...complaints].reverse().forEach(c => {
    const item = document.createElement('div');
    item.className = 'complaint-item';
    
    // Status text mapping for class
    const statusClass = c.status.replace(' ', '-');
    const dateStr = new Date(c.reported_at).toLocaleDateString();

    item.innerHTML = `
      <div class="complaint-item-top">
        <span class="complaint-item-id">${c.id}</span>
        <span class="badge-status ${statusClass}">${c.status}</span>
      </div>
      <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.3rem;">
        <strong>Category:</strong> ${c.category}
      </div>
      <div style="font-size: 0.8rem; color: var(--text-muted); display: flex; justify-content: space-between;">
        <span>${c.location}</span>
        <span>${dateStr}</span>
      </div>
    `;

    item.addEventListener('click', () => {
      elements.lookupIdInput.value = c.id;
      showComplaintDetails(c);
    });

    elements.recentComplaintsList.appendChild(item);
  });
}

elements.btnLookup.addEventListener('click', () => {
  const id = elements.lookupIdInput.value.trim();
  if (!id) return;
  
  const comp = state.complaints.find(c => c.id === id);
  if (comp) {
    showComplaintDetails(comp);
  } else {
    elements.lookupResult.innerHTML = `
      <div style="text-align: center; color: var(--color-error);">
        <i class="fa-solid fa-circle-xmark" style="font-size: 1.5rem; margin-bottom: 0.5rem;"></i>
        <p>No complaint found with Tracking ID: <strong>${id}</strong></p>
      </div>
    `;
  }
});

function showComplaintDetails(c) {
  const statusClass = c.status.replace(' ', '-');
  const dateStr = new Date(c.reported_at).toLocaleString();

  // Create timeline HTML
  const timelineHTML = c.updates.map((update, idx) => {
    const isLast = idx === c.updates.length - 1;
    return `
      <div class="timeline-item">
        <div class="timeline-badge ${isLast ? 'active' : ''}">
          <i class="fa-solid ${update.status === 'Resolved' ? 'fa-check' : 'fa-circle'}"></i>
        </div>
        <div class="timeline-content">
          <div class="timeline-header">
            <span class="timeline-title">${update.status}</span>
            <span class="timeline-time">${new Date(update.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <p class="timeline-comment">${update.comment}</p>
        </div>
      </div>
    `;
  }).join('');

  elements.lookupResult.innerHTML = `
    <div class="complaint-details-header">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
        <h4>Grievance Details</h4>
        <span class="badge-status ${statusClass}">${c.status}</span>
      </div>
      <span style="font-size: 0.8rem; color: var(--text-muted);">Tracking ID: <strong>${c.id}</strong></span>
    </div>
    
    <div class="complaint-meta-grid">
      <div>
        <span class="meta-label" style="font-size:0.7rem; color: var(--text-muted);">Department</span>
        <div style="font-size: 0.85rem; font-weight: 600;">${c.department}</div>
      </div>
      <div>
        <span class="meta-label" style="font-size:0.7rem; color: var(--text-muted);">Priority</span>
        <div style="font-size: 0.85rem; font-weight: 600; color: ${c.priority === 'High' ? 'var(--color-error)' : 'var(--text-primary)'}">${c.priority}</div>
      </div>
      <div>
        <span class="meta-label" style="font-size:0.7rem; color: var(--text-muted);">Citizen Name</span>
        <div style="font-size: 0.85rem; font-weight: 600;">${c.citizen_name}</div>
      </div>
      <div>
        <span class="meta-label" style="font-size:0.7rem; color: var(--text-muted);">Resolution Target</span>
        <div style="font-size: 0.85rem; font-weight: 600;">${c.resolution_time}</div>
      </div>
    </div>

    <div style="margin-bottom: 1rem; border-top: 1px solid var(--border-glass); padding-top: 0.8rem;">
      <span class="meta-label" style="font-size:0.7rem; color: var(--text-muted);">Description</span>
      <p style="font-size: 0.88rem; line-height:1.4; color: var(--text-secondary); margin-top: 0.2rem;">${c.description}</p>
      <small style="font-size: 0.75rem; color: var(--text-muted); display:block; margin-top:0.3rem;">Location: ${c.location}</small>
    </div>

    <div style="border-top: 1px solid var(--border-glass); padding-top: 0.8rem;">
      <span class="meta-label" style="font-size:0.7rem; color: var(--text-muted);">Audit Timeline</span>
      <div class="timeline">${timelineHTML}</div>
    </div>

    <!-- Controlled Status Advancement for Demo -->
    <div class="control-group">
      <span class="control-title">Demo Controls (Advance Status)</span>
      <div class="control-buttons">
        <button class="btn-sm-status" id="demo-in-progress" ${c.status !== 'Received' ? 'disabled' : ''}>
          <i class="fa-solid fa-spinner"></i> In Progress
        </button>
        <button class="btn-sm-status" id="demo-resolved" ${c.status === 'Resolved' ? 'disabled' : ''}>
          <i class="fa-solid fa-circle-check"></i> Resolved
        </button>
      </div>
    </div>
  `;

  // Bind status triggers
  const btnInProgress = document.getElementById('demo-in-progress');
  const btnResolved = document.getElementById('demo-resolved');

  if (btnInProgress) {
    btnInProgress.addEventListener('click', () => updateComplaintStatus(c.id, 'In Progress', 'Field engineers dispatched to resolve issue.'));
  }
  if (btnResolved) {
    btnResolved.addEventListener('click', () => updateComplaintStatus(c.id, 'Resolved', 'Issue successfully resolved. Closed by department supervisor.'));
  }
}

async function updateComplaintStatus(id, status, comment) {
  try {
    const res = await fetch(`/complaint/${id}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, comment })
    });
    const data = await res.json();
    
    // Refresh complaints list and details pane
    await fetchComplaints();
    await fetchStats();
    
    // Show updated details
    showComplaintDetails(data.complaint);
  } catch (err) {
    console.error('Error updating status:', err);
  }
}

// ----------------------------------------------------
// DOCUMENT SIMPLIFIER CONTROLS
// ----------------------------------------------------
elements.quickDocs.forEach(btn => {
  btn.addEventListener('click', () => {
    elements.documentTextInput.value = btn.getAttribute('data-text');
  });
});

elements.btnSimplify.addEventListener('click', async () => {
  const text = elements.documentTextInput.value.trim();
  if (!text) return;

  elements.btnSimplify.disabled = true;
  elements.btnSimplify.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Translating & Simplifying...`;
  elements.simplifyResult.style.display = 'none';

  try {
    const res = await fetch('/simplify-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_text: text })
    });
    
    const data = await res.json();

    elements.simplifiedExplanation.innerText = data.explanation;
    elements.simplifiedActions.innerHTML = '';
    
    data.action_items.forEach(item => {
      const li = document.createElement('li');
      li.innerHTML = `<i class="fa-solid fa-circle-check"></i> <span>${item}</span>`;
      elements.simplifiedActions.appendChild(li);
    });

    if (data.detected_language) {
      elements.simplifyLangTag.innerText = `Responding in ${data.detected_language}`;
      elements.simplifyLangTag.style.display = 'inline-block';
    }

    elements.simplifyResult.style.display = 'block';
    elements.simplifyResult.scrollIntoView({ behavior: 'smooth' });

  } catch (err) {
    alert("Error simplifying document.");
    console.error(err);
  } finally {
    elements.btnSimplify.disabled = false;
    elements.btnSimplify.innerHTML = `<i class="fa-solid fa-file-prescription"></i> Simplify & Extract Checklist`;
  }
});

// ----------------------------------------------------
// AI COMPANION CHAT CONTROLS
// ----------------------------------------------------
elements.btnChatSend.addEventListener('click', sendChatMessage);
elements.chatInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

elements.chatClear.addEventListener('click', () => {
  elements.chatMessages.innerHTML = `
    <div class="chat-msg assistant">
      <div class="bubble">
        <p>Namaste! I am your AI Companion. I can answer questions about government services, checklist requirements, or track your complaints in multiple languages. How may I assist you today?</p>
      </div>
    </div>
  `;
  elements.chatLangTag.innerText = "AI Companion";
  state.selectedServiceId = null;
  state.selectedServiceName = null;
  elements.chatServiceContext.style.display = 'none';
});

async function sendChatMessage() {
  const message = elements.chatInput.value.trim();
  if (!message) return;

  // Render User Message bubble
  appendChatMessage('user', message);
  elements.chatInput.value = '';

  // Render temporary assistant typing bubble
  const typingBubble = document.createElement('div');
  typingBubble.className = 'chat-msg assistant typing-msg';
  typingBubble.innerHTML = `
    <div class="bubble" style="padding: 0.5rem 1rem;">
      <i class="fa-solid fa-ellipsis fa-bounce text-muted"></i> Typing...
    </div>
  `;
  elements.chatMessages.appendChild(typingBubble);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: state.sessionId,
        message: message,
        selected_service_id: state.selectedServiceId
      })
    });
    
    const data = await res.json();
    
    // Remove typing bubble
    const typing = elements.chatMessages.querySelector('.typing-msg');
    if (typing) typing.remove();

    // Render Assistant Response
    appendChatMessage('assistant', data.response, data.detected_language);
    
    // Update main Companion language tag
    if (data.detected_language) {
      elements.chatLangTag.innerText = `Responding in ${data.detected_language}`;
    }

  } catch (err) {
    const typing = elements.chatMessages.querySelector('.typing-msg');
    if (typing) typing.remove();
    
    appendChatMessage('assistant', "I apologize, but I am unable to connect to my brain at the moment. Please check your connectivity.");
    console.error(err);
  }
}

function appendChatMessage(sender, text, lang = null) {
  const container = document.createElement('div');
  container.className = `chat-msg ${sender}`;
  
  // Format markdown lists if returned by assistant
  let formattedText = text;
  if (sender === 'assistant') {
    // Simple replacement of markdown bold / lists to HTML for clean display
    formattedText = text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^\s*•\s*(.*?)$/gm, '<li>$1</li>')
      .replace(/^\s*\*\s*(.*?)$/gm, '<li>$1</li>')
      .replace(/(<li>.*?<\/li>)+/g, '<ul style="margin: 0.5rem 0; padding-left: 1.2rem;">$&</ul>')
      .replace(/\n/g, '<br>');
  }

  container.innerHTML = `
    <div class="bubble">
      <p>${formattedText}</p>
    </div>
    ${lang && sender === 'assistant' ? `<span class="chat-msg-lang-tag"><i class="fa-solid fa-language"></i> ${lang}</span>` : ''}
  `;
  
  elements.chatMessages.appendChild(container);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}
