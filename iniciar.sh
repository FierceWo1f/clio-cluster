#!/data/data/com.termux/files/usr/bin/bash
# Clio: actualiza el proyecto (si hay internet) y arranca el hub. Pensado para Termux en el teléfono.
#
#   bash ~/clio-cluster/iniciar.sh             actualizar y arrancar
#   bash ~/clio-cluster/iniciar.sh --atajo     crear el botón "Clio" de Termux:Widget (una sola vez)
#   bash ~/clio-cluster/iniciar.sh --sin-actualizar
#
# Las opciones que no son de este script se pasan al hub (por ejemplo --musica DIR).

cd "$(dirname "$(readlink -f "$0")")" || exit 1
DIR="$(pwd)"
PORT="${PORT:-8080}"

if [ "$1" = "--atajo" ]; then
  mkdir -p "$HOME/.shortcuts"
  cat > "$HOME/.shortcuts/Clio" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
bash "$DIR/iniciar.sh"
EOF
  chmod +x "$HOME/.shortcuts/Clio"
  echo "Listo. Ahora agrega el widget de Termux:Widget a tu pantalla de inicio y toca \"Clio\"."
  echo "(Termux:Widget se instala desde https://github.com/termux/termux-widget/releases, igual que Termux.)"
  exit 0
fi

ACTUALIZAR=1
if [ "$1" = "--sin-actualizar" ]; then ACTUALIZAR=0; shift; fi

# Evita que Android duerma Termux mientras el hub corre (aparece en la notificación de Termux).
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

# ¿Ya hay un hub corriendo? No arrancar dos.
if python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:$PORT/hub/status', timeout=2); sys.exit(0)" 2>/dev/null; then
  echo "El hub ya está corriendo en el puerto $PORT."
  exit 0
fi

if [ "$ACTUALIZAR" = "1" ]; then
  echo "Buscando actualizaciones…"
  ANTES="$(git rev-parse HEAD 2>/dev/null)"
  if timeout 25 git pull --ff-only -q 2>/dev/null; then
    if [ "$ANTES" != "$(git rev-parse HEAD 2>/dev/null)" ]; then
      echo "Actualizado:"
      git log --oneline "$ANTES..HEAD" 2>/dev/null | head -5
    else
      echo "Ya tenías la última versión."
    fi
  else
    echo "No se pudo actualizar (¿sin internet?). Se usa la versión guardada."
  fi
fi

echo
exec python hub/hub.py --port "$PORT" "$@"
