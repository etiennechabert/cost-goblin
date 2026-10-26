{
  description = "CostGoblin - desktop app for cloud cost visibility";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "costgoblin";
            version = "0.9.2";

            src = ./.;

            npmDepsHash = "sha256-7KU0uFsdL47AOlzeLrQlMgPaVT7lsWB3SkAXyQsmF9U=";

            env = {
              ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
              SENTRYCLI_SKIP_DOWNLOAD = "1";
              PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            };

            npmFlags = [ "--ignore-scripts" ];

            nativeBuildInputs = [ pkgs.makeWrapper ]
              ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];

            buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
              pkgs.stdenv.cc.cc.lib
            ];

            buildPhase = ''
              runHook preBuild
              npm run build --workspace=packages/desktop
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/share/costgoblin
              cp -r packages $out/share/costgoblin/
              cp package.json package-lock.json $out/share/costgoblin/
              cp -r node_modules $out/share/costgoblin/

              (cd $out/share/costgoblin && npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund)

              mkdir -p $out/bin
              makeWrapper ${pkgs.electron_44}/bin/electron $out/bin/costgoblin \
                --add-flags "$out/share/costgoblin"

              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Desktop app for cloud cost visibility";
              homepage = "https://github.com/mipmip/cost-goblin";
              license = licenses.agpl3Only;
              maintainers = [ ];
              mainProgram = "costgoblin";
              platforms = platforms.unix;
            };
          };

          costgoblin = self.packages.${system}.default;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/costgoblin";
        };

        costgoblin = self.apps.${system}.default;
      });

      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [
              nodejs_24
              typescript
              typescript-language-server
              electron_44
              git
              python3
              pkg-config
            ];

            shellHook = ''
              echo "CostGoblin development environment"
              echo "Node.js version: $(node --version)"
              echo "npm version: $(npm --version)"
              echo "Electron version: $(electron --version)"
            '';
          };
        }
      );
    };
}
