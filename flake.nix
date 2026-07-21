{
  description = "Archon - The first open-source harness builder for AI coding";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # nixpkgs-unstable (26.11) dropped x86_64-darwin. Use the 26.05 darwin
    # stable branch for darwin systems — it still supports Intel Macs until
    # end of 2026. Linux systems use nixpkgs-unstable.
    nixpkgs-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs = { self, nixpkgs, nixpkgs-darwin }: let
    # Bump version for each release. The nix-release.yml workflow auto-updates
    # this line and the per-platform sha256 hashes below when a new release is
    # published — no manual editing required.
    version = "0.5.0";

    assets = {
      "x86_64-linux" = {
        file = "archon-linux-x64";
        sha256 = "sha256-3/FrgQoHNsZRyt/7TwzvjspJHzwhN9ZKojJMBzM/tFU=";
      };
      "aarch64-linux" = {
        file = "archon-linux-arm64";
        sha256 = "sha256-dMhniBIeOG/nwwncUXhBfqVVeV/JKATX69wfFumNYIA=";
      };
      "x86_64-darwin" = {
        file = "archon-darwin-x64";
        sha256 = "sha256-gtRvL59SBYXH4DDLSPbX8XTFNIEKlCJ62M6DuzJV7lk=";
      };
      "aarch64-darwin" = {
        file = "archon-darwin-arm64";
        sha256 = "sha256-MlinhBP2zA64+yFLMpO8y722cMCclzghYz7keMbZG9E=";
      };
    };

    systems = builtins.attrNames assets;
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);

    # Select the right nixpkgs input per system: darwin uses the 26.05-darwin
    # branch (still supports x86_64-darwin), linux uses unstable.
    pkgsFor = system:
      if nixpkgs.lib.hasSuffix "darwin" system
      then nixpkgs-darwin.legacyPackages.${system}
      else nixpkgs.legacyPackages.${system};

    # Prebuilt binary from GitHub release (raw compiled binary, not a tarball)
    projectFor = system: let
      pkgs = pkgsFor system;
      asset = assets.${system};
    in pkgs.stdenv.mkDerivation {
      pname = "archon";
      inherit version;

      src = pkgs.fetchurl {
        url = "https://github.com/coleam00/Archon/releases/download/v${version}/${asset.file}";
        sha256 = asset.sha256;
      };

      sourceRoot = ".";

      nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];
      buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.stdenv.cc.cc.lib ];

      dontUnpack = true;
      dontConfigure = true;
      dontBuild = true;

      installPhase = ''
        runHook preInstall
        install -Dm755 $src $out/bin/archon
        runHook postInstall
      '';

      meta = with pkgs.lib; {
        description = "Archon - The first open-source harness builder for AI coding";
        homepage = "https://github.com/coleam00/Archon";
        downloadPage = "https://github.com/coleam00/Archon/releases";
        license = licenses.mit;
        mainProgram = "archon";
        platforms = systems;
        sourceProvenance = [ sourceTypes.binaryNativeCode ];
      };
    };

    # From-source build — replicates scripts/build-binaries.sh:
    #   1. bun install --frozen-lockfile (via deps FOD for sandbox network isolation)
    #   2. bun run scripts/generate-bundled-defaults.ts (code generation)
    #   3. Rewrite packages/paths/src/bundled-build.ts with version/commit constants
    #   4. bun build --compile --minify --target=<triple> --outfile=archon packages/cli/src/cli.ts
    sourceFor = system: let
      pkgs = pkgsFor system;
      bunTarget = {
        x86_64-linux = "bun-linux-x64";
        aarch64-linux = "bun-linux-arm64";
        x86_64-darwin = "bun-darwin-x64";
        aarch64-darwin = "bun-darwin-arm64";
      }.${system} or (throw "Unsupported platform: ${system}");

      # Fixed-output derivation: runs `bun install` with network access,
      # produces a node_modules store path. The hash must be updated when
      # bun.lock changes — the nix-release.yml workflow does not yet automate
      # this; run `nix build .#source` after changing bun.lock to get the
      # correct hash from the mismatch error.
      # ponytail: FOD hash must be updated when bun.lock changes; no automation yet.
      deps = pkgs.stdenv.mkDerivation {
        pname = "archon-deps";
        inherit version;
        src = ./.;

        nativeBuildInputs = [ pkgs.bun ];

        impureEnvVars = [ "HOME" "XDG_CACHE_HOME" ];
        BUN_INSTALL_CACHE_DIR = "$TMPDIR/bun-cache";

        dontBuild = true;
        dontConfigure = true;

        installPhase = ''
          runHook preInstall
          bun install --frozen-lockfile
          mkdir -p $out
          cp -r node_modules $out/node_modules
          runHook postInstall
        '';

        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-+/vRTaUhwDIRj34eKYzucTr5+jRCmgCqbf6/4XyD2fQ=";
      };
    in pkgs.stdenv.mkDerivation {
      pname = "archon-source";
      inherit version;
      src = ./.;

      nativeBuildInputs = [ pkgs.bun ];

      BUN_INSTALL_CACHE_DIR = "$TMPDIR/bun-cache";

      dontConfigure = true;

      buildPhase = ''
        runHook preBuild

        # Use pre-fetched node_modules from the deps FOD
        cp -r ${deps}/node_modules ./node_modules

        # Step 1: Regenerate bundled defaults from .archon/{commands,workflows}/defaults/
        bun run scripts/generate-bundled-defaults.ts

        # Step 2: Rewrite build-time constants (replicate scripts/build-binaries.sh)
        cat > packages/paths/src/bundled-build.ts << 'BUNDEDEOF'
        export const BUNDLED_IS_BINARY = true;
        export const BUNDLED_VERSION = '${version}';
        export const BUNDLED_GIT_COMMIT = 'nix-build';
        BUNDEDEOF

        # Step 3: Build standalone binary via bun build --compile
        bun build --compile --minify --target ${bunTarget} \
          --outfile archon \
          packages/cli/src/cli.ts

        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        install -Dm755 archon $out/bin/archon
        runHook postInstall
      '';

      meta = with pkgs.lib; {
        description = "Archon - The first open-source harness builder for AI coding";
        homepage = "https://github.com/coleam00/Archon";
        license = licenses.mit;
        mainProgram = "archon";
        platforms = systems;
      };
    };
  in {
    packages = forAllSystems (system: rec {
      archon = projectFor system;
      prebuilt = archon;
      default = prebuilt;
      source = sourceFor system;
    });

    apps = forAllSystems (system: let
      # WARNING: do NOT replace this `let` binding with `rec` referencing the
      # `packages` attrset above. A `rec { default = { program = "${archon}/bin/..."; }; }`
      # that names the binding `archon` shadows the `let`-bound derivation, so
      # `${archon}` interpolates the app attrset (a set, not a store path) and
      # throws "cannot coerce a set to a string" at `nix run` / `nix flake check`.
      archonPkg = projectFor system;
      sourcePkg = sourceFor system;
    in {
      archon = {
        type = "app";
        program = "${archonPkg}/bin/archon";
      };
      prebuilt = {
        type = "app";
        program = "${archonPkg}/bin/archon";
      };
      default = {
        type = "app";
        program = "${archonPkg}/bin/archon";
      };
      source = {
        type = "app";
        program = "${sourcePkg}/bin/archon";
      };
    });

    checks = forAllSystems (system: {
      # CI exercises both the prebuilt and source outputs
      prebuilt = projectFor system;
      source = sourceFor system;
    });
  };
}
