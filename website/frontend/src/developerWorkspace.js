// frontend/src/developerWorkspace.js

const API_URL = '/api/developer/workspace';

async function loadDeveloperWorkspace() {
  try {
    console.log('Loading developer workspace...');

    const response = await fetch(`${API_URL}/assets`, {
      method: 'GET',
      credentials: 'include'
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Developer workspace request failed:', data);
      return;
    }

    console.log('Developer workspace:', data.workspace);
    console.log('Developer assets:', data.assets);

  } catch (err) {
    console.error('Failed to load developer workspace:', err);
  }
}

loadDeveloperWorkspace();
