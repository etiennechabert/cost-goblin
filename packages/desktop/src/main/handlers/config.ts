import { ipcMain } from 'electron';
import { asDimensionId } from '@costgoblin/core';
import type {
  CostGoblinConfig,
  Dimension,
  OrgNode,
} from '@costgoblin/core';
import type { AppContext } from './context.js';

export function registerConfigHandlers(app: AppContext): void {
  const { getConfig, getDimensions, getOrgTreeConfig } = app;

  ipcMain.handle('config:get', async (): Promise<CostGoblinConfig> => {
    return getConfig();
  });

  ipcMain.handle('config:dimensions', async (): Promise<Dimension[]> => {
    const dimensions = await getDimensions();
    const builtIn: Dimension[] = dimensions.builtIn.map(d => ({
      name: asDimensionId(d.name),
      label: d.label,
      field: d.field,
      ...(d.displayField === undefined ? {} : { displayField: d.displayField }),
    }));
    const tags: Dimension[] = dimensions.tags.map(d => ({
      tagName: d.tagName,
      label: d.label,
      ...(d.concept === undefined ? {} : { concept: d.concept }),
      ...(d.normalize === undefined ? {} : { normalize: d.normalize }),
      ...(d.separator === undefined ? {} : { separator: d.separator }),
      ...(d.aliases === undefined ? {} : { aliases: d.aliases }),
    }));
    return [...builtIn, ...tags];
  });

  ipcMain.handle('config:org-tree', async (): Promise<OrgNode[]> => {
    const orgTree = await getOrgTreeConfig();
    return [...orgTree.tree];
  });
}
