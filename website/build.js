const fs = require('fs');
const path = require('path');

// Page compilation configurations
const pageConfigurations = [
  {
    output: 'frontend/superuserDashboard.html',
      title: 'Superuser Command Center',
      script: './src/superuser.js',
      styles: './src/styles.css',
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
  <link rel="stylesheet" href="${config.styles}">
</head>
<body>
  <div id="superuser-app" class="dashboard-container">
    ${bodyContent}
  </div>

  <script type="module" src="${config.script}"></script>
</body>
</html>`;

  // Write compiled HTML
  const outputPath = path.resolve(__dirname, config.output);
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
