// frontend/sandbox-engine.js
const canvas = document.getElementById('sandbox-canvas');
const overlay = document.getElementById('canvas-overlay');
const hud = document.getElementById('hud');
const scoreEl = document.getElementById('score');

if (canvas && overlay) {
  const ctx = canvas.getContext('2d');
  let isPlaying = false;
  let score = 0;
  let player = { x: 0, y: 0, radius: 10, speed: 3.5 };
  let collectibles = [];
  const keys = {};

  overlay.addEventListener('click', () => {
    overlay.classList.add('d-none');
    hud?.classList.remove('d-none');
    isPlaying = true;

    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    player.x = canvas.width / 2;
    player.y = canvas.height / 2;

    spawnNodes(6);
    requestAnimationFrame(gameLoop);
  });

 

    // Safely handle keydown/keyup (prevents Autofill crashes)
    window.addEventListener('keydown', (e) => {
	if (typeof e.key === 'string') {
	    keys[e.key.toLowerCase()] = true;
	}
    });

    window.addEventListener('keyup', (e) => {
	if (typeof e.key === 'string') {
	    keys[e.key.toLowerCase()] = false;
	}
    });
    
  function spawnNodes(count) {
    for (let i = 0; i < count; i++) {
      collectibles.push({
        x: Math.random() * (canvas.width - 40) + 20,
        y: Math.random() * (canvas.height - 40) + 20,
        radius: 6
      });
    }
  }

  function update() {
    if (keys['w'] || keys['arrowup']) player.y -= player.speed;
    if (keys['s'] || keys['arrowdown']) player.y += player.speed;
    if (keys['a'] || keys['arrowleft']) player.x -= player.speed;
    if (keys['d'] || keys['arrowright']) player.x += player.speed;

    player.x = Math.max(player.radius, Math.min(canvas.width - player.radius, player.x));
    player.y = Math.max(player.radius, Math.min(canvas.height - player.radius, player.y));

    collectibles.forEach((node, index) => {
      const dist = Math.hypot(player.x - node.x, player.y - node.y);
      if (dist < player.radius + node.radius) {
        collectibles.splice(index, 1);
        if (scoreEl) {
          score += 10;
          scoreEl.textContent = score;
        }
        spawnNodes(1);
      }
    });
  }

  function render() {
    ctx.fillStyle = '#090a0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }

    collectibles.forEach(node => {
      ctx.fillStyle = '#ffc107';
      ctx.beginPath(); ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2); ctx.fill();
    });

    ctx.fillStyle = '#0d6efd';
    ctx.beginPath(); ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function gameLoop() {
    if (!isPlaying) return;
    update();
    render();
    requestAnimationFrame(gameLoop);
  }
}
