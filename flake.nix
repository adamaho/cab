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
          browserLibraries = with pkgs; lib.optionals stdenv.isLinux [
            alsa-lib
            at-spi2-atk
            atk
            cairo
            cups
            dbus
            expat
            glib
            gtk3
            libdrm
            libxkbcommon
            mesa
            nspr
            nss
            pango
            libx11
            libxcomposite
            libxdamage
            libxext
            libxfixes
            libxrandr
            libxcb
          ];
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              docker
              docker-compose
              git
              nodejs_24
              pnpm_11
            ] ++ browserLibraries;

            shellHook = ''
              alias opencode-p='XDG_DATA_HOME="$HOME/.local/share/opencode-personal-profile" opencode'
              ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
                export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath browserLibraries}:''${LD_LIBRARY_PATH:-}"
              ''}
            '';
          };
        });
    };
}
