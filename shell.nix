{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs_22       # Provides node, npm, and npx
    nginx           # Web server for proxying/testing static builds
    sqlite

    # pdftotext, and the rest of the poppler utilities. ADDED 2026-10-15 so the
    # specifications in docs/ can be read.
    #
    # THE THREE ORIGINAL SPECS ARE PDFs, and until this was here there was no way
    # to read them from this machine at all — the streams are Flate-compressed
    # font and image data, so decompressing them yields noise rather than prose.
    # That is why docs/assettypes01 §5B went unread for a fortnight while its
    # contents were re-derived in conversation (TODO 78).
    #
    # It is a READER, not a dependency of the portal. Nothing in the application
    # calls it, and nothing breaks if it is removed.
    #
    # THE NAME IS HYPHENATED AND THEREFORE QUOTED. It was `poppler_utils` and
    # nixpkgs renamed it: writing the underscore gets
    #     error: 'poppler_utils' has been renamed to/replaced by 'poppler-utils'
    # AND NOTHING SAYS SO OUT LOUD. nix-direnv falls back to the PREVIOUS
    # environment when evaluation fails, so the shell comes up looking perfectly
    # healthy — node, nginx and sqlite all working, and only the thing just added
    # missing. Which reads as "the package did not make it onto PATH" rather than
    # "the file does not evaluate".
    pkgs."poppler-utils"
  ];

  shellHook = ''
    echo "🎮 Low Expectations Web Environment Loaded!"
    echo "Node:  $(node -v)"
    echo "NPM:   $(npm -v)"
    echo "Nginx: $(nginx -v 2>&1)"
    echo "PDF:   $(pdftotext -v 2>&1 | head -1)"
  '';
}