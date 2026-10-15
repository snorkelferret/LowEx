const fs = require('fs');
const path = require('path');

// Page compilation configurations
const pageConfigurations = [
 {
    output: 'frontend/adminDashboard.html',
    title: 'Admin Management',
     scripts: [
      './src/header.js',          // Fill in login details
      './src/admin.js',    // Admin Core logic
      './src/sharedInvites.js',   // Exact same single-instance file compiled here!
      './src/adminUsers.js',      // Accounts table
      './src/adminReports.js',    // Reports - shared the same way
      './src/adminAudit.js',      // Audit log - shared the same way
      './src/adminSettings.js',   // Settings - shared the same way
      './src/adminStorage.js',    // Storage - shared the same way
      './src/feedback.js',        // Report-a-problem button
      './src/utilityBar.js',      // The utility bar: manual, and whatever else a page adds
      './src/adminTabs.js',       // The admin sections, switched by id
      './src/notBuilt.js'         // Menu stubs for features that are not built yet
    ],
    styles: '/styles/styles.css',
    modules: [
      'frontend/src/components/header.html',
      'frontend/src/components/adminPanel.html',
      'frontend/src/components/devInvites.html',
      'frontend/src/components/adminReports.html',
      'frontend/src/components/adminAudit.html',
      'frontend/src/components/adminSettings.html',
      'frontend/src/components/adminStorage.html',
    ],
 },
    
{
    output: 'frontend/devDashboard.html',
    title: 'Developer Dashboard',
    scripts: [
	'./src/header.js',          // Fill in login details
	'./src/developerPanel.js',
	'./src/developerWorkspace.js',
	'./src/developerLibrary.js', // The Library tab: shared source material
	'./src/developerStore.js',   // The Game store tab: approved work, read
	'./src/feedback.js',        // Report-a-problem button
	'./src/utilityBar.js',     // The utility bar: manual, and whatever else a page adds
	'./src/notBuilt.js'         // Menu stubs for features that are not built yet
    ],
    styles: '/styles/styles.css',
    modules: [
	'frontend/src/components/header.html',
	'frontend/src/components/developerPanel.html',
	'frontend/src/components/developerAssets.html',
    ],
},

{
    // Production — where a `prod` account lands after signing in.
    //
    // ONE JOB, ONE PANEL. Prod has no workspace, no admin powers, and cannot
    // deactivate or invite anybody, so there is nothing else to put here and
    // offering more would be offering what the server refuses.
    //
    // No loginModal: that dialog belonged to the removed superuser page.
    output: 'frontend/prodDashboard.html',
    title: 'Production',
    scripts: [
      './src/header.js',          // Fills in who is signed in, and signs them out
      './src/prodPanel.js',       // The queue of what is waiting, and the decisions
      './src/feedback.js',        // Report-a-problem button
      './src/utilityBar.js',      // The utility bar
    ],
    styles: '/styles/styles.css',
    modules: [
      'frontend/src/components/header.html',
      'frontend/src/components/prodPanel.html',
    ],
},

{
    // The tester's home — where a `user` account lands after signing in.
    //
    // ASSEMBLED LIKE EVERY OTHER SIGNED-IN PAGE, which it was not until
    // 2026-10-06. It was the only hand-written page behind the sign-in, and
    // that is exactly why it had drifted: its own navbar instead of the shared
    // header, a Discussion button duplicating the one in the utility bar beside
    // it, and a card still badged "Not built yet" for a report-a-problem form
    // that had worked for weeks. Nothing generated it, so nothing updated it.
    //
    // No loginModal: that dialog is the superuser's "sign in as another user"
    // and is opened by superuser.js, which is not loaded here.
    // No tabs either — there is one section, and a single tab is not a tab
    // strip, it is a heading with extra steps.
    output: 'frontend/user.html',
    title: 'Low Expectations - Your Account',
    scripts: [
      './src/header.js',          // Fills in who is signed in, and signs them out
      './src/userLanding.js',     // Asks the server who this is, and fills the panel
      './src/feedback.js',        // Report-a-problem button
      './src/utilityBar.js',      // The utility bar: manual, discussion, report
    ],
    styles: '/styles/styles.css',
    modules: [
      'frontend/src/components/header.html',
      'frontend/src/components/userLanding.html',
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

  // Read and combine all component HTML partials.
  //
  // THE HEADER IS COLLECTED SEPARATELY, and it is not a detail. Every other
  // component is page content and belongs inside the padded container; the
  // header spans the full width with its own background and a border along the
  // bottom, and putting it inside means either the header stops short of the
  // edges or the content has no inset at all.
  //
  // That second one is what had been happening: .dashboard-container was never
  // styled, so it had NO padding, the header's own padding was the only inset
  // on the page, and every heading and card below it sat flush against the
  // viewport edge.
  let headerContent = '';
  let bodyContent = '';

  for (const modulePath of config.modules) {
    const fullPath = path.resolve(__dirname, modulePath);
    const isChrome = modulePath.endsWith('header.html');

    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const block = `\n<!-- Module: ${modulePath} -->\n${content}\n`;

      if (isChrome) headerContent += block;
      else bodyContent += block;
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
${headerContent}
  <div class="dashboard-container">
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
