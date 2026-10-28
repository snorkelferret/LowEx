# allowUnfree IS HERE FOR PERFORCE, AND ONLY FOR PERFORCE.
#
# p4d and p4 are the Helix Core server and client, and they are proprietary —
# nixpkgs marks them unfree, so without this the shell fails to evaluate and
# nix-direnv silently falls back to the PREVIOUS environment. That is the same
# trap the poppler note below describes: a shell that comes up looking healthy
# with only the thing just added missing.
#
# THE ALTERNATIVE TO THIS LINE IS NIXPKGS_ALLOW_UNFREE=1 ON THE COMMAND, which
# works and which nobody remembers when they open a new terminal. IT BELONGS IN
# A FILE. See TODO 88.
{ pkgs ? import <nixpkgs> { config.allowUnfree = true; } }:

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

    # PERFORCE — the game's version control, not the portal's dependency.
    #
    #   p4d   the SERVER. Started once, not typed day to day; it is here so the
    #         sandbox can be started without hunting a store path.
    #   p4    the CLIENT. What a developer runs: sync, edit, submit. This is the
    #         one that genuinely needs to be on PATH.
    #
    # UNREAL DOES NOT NEED EITHER: the editor speaks Perforce through an API
    # compiled into it. What needs p4 is anything scripted — the build machine,
    # automation, and your own fingers.
    #
    # IT IS NOT A DEPENDENCY OF THE PORTAL. Nothing in the application calls it,
    # and the portal is unaffected if these are removed. See TODO 88 and the
    # "Perforce sandbox" section of the manual.
    p4
    p4d
  ];

  shellHook = ''
    echo "🎮 Low Expectations Web Environment Loaded!"
    echo "Node:  $(node -v)"
    echo "NPM:   $(npm -v)"
    echo "Nginx: $(nginx -v 2>&1)"
    echo "PDF:   $(pdftotext -v 2>&1 | head -1)"
    echo "P4:    $(p4 -V 2>&1 | head -1) — server: $(p4d -V 2>&1 | head -1)"
  '';
}