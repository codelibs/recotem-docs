<script setup lang="ts">
import { computed, ref } from 'vue'
import { useData, useRouter } from 'vitepress'

const { page } = useData()
const router = useRouter()

const isV1 = computed(() => page.value.relativePath.startsWith('1.0/'))
const isJa = computed(() => {
  const p = page.value.relativePath
  return p.startsWith('ja/') || p.startsWith('1.0/ja/')
})

const currentVersion = computed(() => isV1.value ? '1.0' : '2.0')

const v2Link = computed(() => isJa.value ? '/ja/' : '/')
const v1Link = computed(() => isJa.value ? '/1.0/ja/' : '/1.0/')

const open = ref(false)

function navigate(url: string) {
  open.value = false
  router.go(url)
}
</script>

<template>
  <div class="VPVersionSwitcher" @mouseenter="open = true" @mouseleave="open = false">
    <button class="version-button" :aria-expanded="open">
      {{ currentVersion }}
      <span class="vpi-chevron-down" />
    </button>
    <div v-if="open" class="version-menu">
      <a
        class="version-item"
        :class="{ active: !isV1 }"
        :href="v2Link"
        @click.prevent="navigate(v2Link)"
      >2.0</a>
      <a
        class="version-item"
        :class="{ active: isV1 }"
        :href="v1Link"
        @click.prevent="navigate(v1Link)"
      >1.0</a>
    </div>
  </div>
</template>
