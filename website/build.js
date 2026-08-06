const fs = require('fs');
const path = require('path');

// Page compilation configurations
const pageConfigurations = [
  {
    output: 'frontend/superuserDashboard.html',
    title: 'Superuser Command Center',
    script: './src/superuser.js',
    styles: '/styles.css',
    modules: [
      'frontend/src/components/header.html',
      'frontend/src/components/adminPanel.html',
      'frontend/src/components/developerPanel.html',
      'frontend/src/components/repoControl.html',
      'frontend/src/components/cloudflareControl.html',
      'frontend/src/components/loginModal.html',
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

  // HTML Template wrapper
  const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.title}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css" rel="stylesheet">
  <link rel="stylesheet" href="${config.styles}">
</head>
<body class="bg-dark text-light min-vh-100 d-flex flex-column">
  <div id="superuser-app" class="dashboard-container">
    ${bodyContent}
  </div>

  <!-- Bootstrap 5 JS Bundle (Always included prior to app logic) -->
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  
  <!-- App Entry Script -->
  <script type="module" src="${config.script}"></script>
</body>
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
