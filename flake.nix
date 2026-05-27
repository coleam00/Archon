{
  description = "Archon - The first open-source harness builder for AI coding";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }@inputs:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Platform-specific binary selection
        platform = pkgs.stdenv.hostPlatform.system;
        selectBinary = {
          x86_64-linux = "archon-linux-x64";
          aarch64-linux = "archon-linux-arm64";
          x86_64-darwin = "archon-darwin-x64";
          aarch64-darwin = "archon-darwin-arm64";
        }.${platform} or (throw "Unsupported platform: ${platform}");

        # Binary package from GitHub release
        archon-bin = pkgs.fetchurl {
          url = "https://github.com/coleam00/Archon/releases/download/v0.3.12/${selectBinary}";
          sha256 = {
            x86_64-linux = "1s60pi16z1wxd4fpilzrwddfv2qk6mxqcv5b5206bh38cfgnxhw7";
            aarch64-linux = "1jw26wyjd3ffs3g3sgbd7f5ybvrlf00pj3rlmfrr0crsymn7r2gi";
            x86_64-darwin = "0yi3avs107qnhcxiiy4f88hamd1ix9kfpkbxr05dlj2pgarg0nri";
            aarch64-darwin = "08f4qxliqx29rkarc6dhpr7jrph4yvsp3kzphdn15d9dcyr3vmf7";
          }.${platform};
        };

        # Wrapper to make binary executable
        archon = pkgs.stdenv.mkDerivation {
          pname = "archon";
          version = "0.3.12"; # Bump version for each release
          src = archon-bin;

          dontUnpack = true;
          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            install -Dm755 $src $out/bin/archon
          '';

          meta = {
            description = "The first open-source harness builder for AI coding";
            homepage = "https://github.com/coleam00/Archon";
            license = pkgs.lib.licenses.mit;
            mainProgram = "archon";
          };
        };
      in
      {
        packages.default = archon;
        apps.default = {
          type = "app";
          program = "${archon}/bin/archon";
          meta = {
            description = "Archon - The first open-source harness builder for AI coding";
          };
        };

        # CI/CD checks
        checks = {
          build = archon;
        };
      }
    );
}
