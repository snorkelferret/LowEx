const fs = require('fs');
const path = require('path');

// Page compilation configurations
const pageConfigurations = [
  {
    output: 'frontend/superuserDashboard.html',
      title: 'Superuser Command Center',
      scripts: [
      './src/header.js',          // Fill in login details	  
      './src/superuser.js',       // Superuser Core Panel logic
      './src/sharedInvites.js',   // Single-instance shared developer invite code
      './src/adminUsers.js',      // Accounts table - shared with the admin dashboard
      './src/adminReports.js',    // Reports - shared the same way
      './src/feedback.js',        // Report-a-problem button. Builds its own markup.
      './src/manualLink.js',      // The manual, as a corner glyph
      './src/notBuilt.js'         // Menu stubs for features that are not built yet
    ],
    styles: '/styles/styles.css',
    modules: [
      'frontend/src/components/header.html',
      'frontend/src/components/adminPanel.html',
      'frontend/src/components/devInvites.html',
      'frontend/src/components/adminReports.html', 
      'frontend/src/components/developerPanel.html',
      'frontend/src/components/repoControl.html',
      'frontend/src/components/cloudflareControl.html',
      'frontend/src/components/loginModal.html',
    ],
  },
 {
    output: 'frontend/adminDashboard.html',
    title: 'Admin Management',
     scripts: [
      './src/header.js',          // Fill in login details
      './src/admin.js',    // Admin Core logic
      './src/sharedInvites.js',   // Exact same single-instance file compiled here!
      './src/adminUsers.js',      // Accounts table - shared with the superuser dashboard
      './src/adminReports.js',    // Reports - shared the same way
      './src/feedback.js',        // Report-a-problem button
      './src/manualLink.js',      // The manual, as a corner glyph
      './src/notBuilt.js'         // Menu stubs for features that are not built yet
    ],
    styles: '/styles/styles.css',
    modules: [
      'frontend/src/components/header.html',
      'frontend/src/components/adminPanel.html',
      'frontend/src/components/devInvites.html',
      'frontend/src/components/adminReports.html',
      'frontend/src/components/loginModal.html',
    ],
 },
    
{
    output: 'frontend/devDashboard.html',
    title: 'Developer Dashboard',
    scripts: [
	'./src/header.js',          // Fill in login details
	'./src/developerPanel.js',
	'./src/developerWorkspace.js',
	'./src/feedback.js',        // Report-a-problem button
	'./src/manualLink.js',      // The manual, as a corner glyph
	'./src/notBuilt.js'         // Menu stubs for features that are not built yet
    ],
    styles: '/styles/styles.css',
    modules: [
	'frontend/src/components/header.html',
	'frontend/src/components/developerPanel.html',
	'frontend/src/components/developerAssets.html',
	'frontend/src/components/loginModal.html',
    ],
},

{
    // The page an invitation link lands on. Deliberately NOT behind the app
    // shell: whoever arrives here has no account yet, so there is nothing to
    // log in to. It handles a pending invitation, and says something useful
    // for the other three states — expired (with a reissue), revoked, and
    // already used.
    output: 'frontend/register.html',
    title: 'Accept Invitation',
    scripts: [
	'./src/register.js',
	// An expired or refused invitation is exactly the kind of thing someone
	// needs to report, and they have no account to report it with.
	'./src/feedback.js'
    ],
    styles: '/styles/styles.css',
    modules: [
	'frontend/src/components/registerForm.html',
    ],
},

    
];

function compilePage(config) {
  console.log(`🔨 Building: ${config.output}...`);

  // Read and combine all component HTML partials
  let bodyContent = '';
  for (const modulePath of config.modules) {
    const fullPath = path.resolve(__dirname, modulePath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      bodyContent += `\n<!-- Module: ${modulePath} -->\n${content}\n`;
    } else {
      console.warn(`  ⚠️ Warning: Component file missing at ${modulePath}. Inserting placeholder container.`);
      bodyContent += `\n<!-- Missing Module: ${modulePath} -->\n<section class="card missing-module"><p>Module loading error: ${modulePath}</p></section>\n`;
    }
  }

  // Generate individual <script> tags for each script file listed in the array
  let scriptTags = '';
  if (Array.isArray(config.scripts)) {
    config.scripts.forEach(scriptPath => {
      scriptTags += `  <script type="module" src="${scriptPath}"></script>\n`;
    });
  }

  // HTML Template wrapper
  const htmlTemplate = `<!DOCTYPE html>
<html lang="en" data-bs-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.title}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css" rel="stylesheet">
  <link rel="stylesheet" href="${config.styles}">
</head>
<body class="bg-dark text-light min-vh-100 d-flex flex-column">
  <div  class="dashboard-container">
    ${bodyContent}
  </div>

  <!-- Bootstrap 5 JS Bundle (Always included prior to app logic) -->
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  
  <!-- App Entry Scripts -->
${scriptTags}</body>
</html>`;

  // Ensure output directory exists before writing
  const outputPath = path.resolve(__dirname, config.output);
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write compiled HTML
  fs.writeFileSync(outputPath, htmlTemplate, 'utf-8');
  console.log(`  ✅ Successfully compiled -> ${config.output}`);
}

// Run compilation for all configured pages
function buildAll() {
  console.log('🚀 Starting modular page compilation...\n');
  pageConfigurations.forEach(compilePage);
  console.log('\n✨ Build complete!');
}
buildAll();
