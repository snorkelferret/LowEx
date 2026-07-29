{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs_22       # Provides node, npm, and npx
    nginx           # Web server for proxying/testing static builds
  ];

  shellHook = ''
    echo "🎮 Low Expectations Web Environment Loaded!"
    echo "Node:  $(node -v)"
    echo "NPM:   $(npm -v)"
    echo "Nginx: $(nginx -v 2>&1)"
  '';
}