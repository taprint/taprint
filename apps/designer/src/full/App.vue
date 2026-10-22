<script setup lang="ts">
// full 模式主壳（设计契约）
</script>

<template>
  <div class="flex h-screen flex-col">
    <header class="flex items-center gap-4 border-b border-gray-200 px-4 py-2 text-sm font-medium">
      <span class="text-primary">Taprint 打印模板设计器</span>
      <nav class="flex gap-3">
        <router-link to="/">模板列表</router-link>
      </nav>
    </header>
    <main class="flex-1 overflow-auto">
      <router-view />
    </main>
  </div>
</template>
