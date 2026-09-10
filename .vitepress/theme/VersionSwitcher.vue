<script setup lang="ts">
import { computed, ref } from 'vue'
import { useData, useRouter } from 'vitepress'

const { page } = useData()
const router = useRouter()

const rel = computed(() => page.value.relativePath)
const isV1 = computed(() => rel.value.startsWith('1.0/'))
const isV20 = computed(() => rel.value.startsWith('2.0/'))
const isJa = computed(() => {
  const p = rel.value
  return (
    p.startsWith('ja/') ||
    p.startsWith('1.0/ja/') ||
    p.startsWith('2.0/ja/') ||
    p.startsWith('2.1/ja/')
  )
})

const currentVersion = computed(() =>
  isV1.value ? '1.0' : isV20.value ? '2.0' : '2.1',
)

// The current stable (2.1) is unversioned at the root; older versions
// live under their own directories. Switching jumps to that version's home.
const latestLink = computed(() => (isJa.value ? '/ja/' : '/'))
const v20Link = computed(() => (isJa.value ? '/2.0/ja/' : '/2.0/'))
const v1Link = computed(() => (isJa.value ? '/1.0/ja/' : '/1.0/'))

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
        :class="{ active: !isV1 && !isV20 }"
        :href="latestLink"
        @click.prevent="navigate(latestLink)"
      >2.1</a>
      <a
        class="version-item"
        :class="{ active: isV20 }"
        :href="v20Link"
        @click.prevent="navigate(v20Link)"
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
