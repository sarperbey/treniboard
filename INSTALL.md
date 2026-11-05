# Installation Guide

Quick guide to install **Treniboard** for GNOME Shell (GNOME 48–51).

## 1. Create Directory

Create the extension directory (replace `treniboard@yourdomain.com` with your extension UUID):

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/treniboard@yourdomain.com
```

## 2. Copy Files

Place `extension.js` inside the directory:

```bash
cp extension.js ~/.local/share/gnome-shell/extensions/treniboard@yourdomain.com/
```

## 3. Create `metadata.json`

Create `metadata.json` in the same directory:

```json
{
  "name": "Treniboard",
  "description": "Live ViaggiaTreno status board for GNOME Shell",
  "uuid": "treniboard@yourdomain.com",
  "shell-version": ["48", "49", "50", "51"]
}
```

## 4. Enable Extension

1. **Restart GNOME Shell**: Press `Alt + F2`, type `r` and press `Enter` (X11) or log out and log back in (Wayland).
2. **Enable via CLI**:

```bash
gnome-extensions enable treniboard@yourdomain.com
```

Or enable it using the **Extensions** app.