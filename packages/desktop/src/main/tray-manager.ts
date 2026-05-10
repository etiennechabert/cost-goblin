import { Tray, Menu, nativeImage, type BrowserWindow } from 'electron';
import { logger } from '@costgoblin/core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;

function toggleWindowVisibility(): void {
  if (mainWindow === null) return;

  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function buildContextMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Show CostGoblin',
      click: () => {
        if (mainWindow === null) return;
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: 'Hide CostGoblin',
      click: () => {
        if (mainWindow === null) return;
        mainWindow.hide();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        if (mainWindow !== null) {
          mainWindow.destroy();
        }
      },
    },
  ]);
}

export function initTray(window: BrowserWindow): void {
  mainWindow = window;

  const iconPath = join(__dirname, '..', '..', 'resources', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);

  // Resize icon for tray (16x16 or 32x32 depending on platform)
  const trayIcon = icon.resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);
  tray.setToolTip('CostGoblin - Cloud Cost Visibility');
  tray.setContextMenu(buildContextMenu());

  tray.on('click', () => {
    toggleWindowVisibility();
  });

  logger.info('Tray icon initialized');
}

export function destroyTray(): void {
  if (tray !== null) {
    tray.destroy();
    tray = null;
    logger.info('Tray icon destroyed');
  }
}
