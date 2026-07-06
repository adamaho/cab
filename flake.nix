{
  description = "Development shell for cab";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              docker
              docker-compose
              git
              nodejs_24
              pnpm_11
            ];

            shellHook = ''
              alias opencode-p='XDG_DATA_HOME="$HOME/.local/share/opencode-personal-profile" opencode'
            '';
          };
        });
    };
}
