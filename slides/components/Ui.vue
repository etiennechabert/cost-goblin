<!-- A label exactly as it reads on screen (a button, a field, a menu item), so
     viewers know what to look for: <Ui>Create export</Ui> -->
<template>
  <span class="cg-ui"><slot /></span>
</template>

<style scoped>
.cg-ui {
  display: inline-block;
  padding: 0 7px;
  border: 1px solid var(--cg-border-strong);
  border-radius: 6px;
  background: var(--cg-bg-card);
  font-size: 0.86em;
  font-weight: 500;
  line-height: 1.55;
  color: var(--cg-text);
  white-space: nowrap;
}
</style>
