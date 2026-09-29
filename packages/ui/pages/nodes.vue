<script setup lang="ts">
import type {
  ManagedNode,
  NodePreviewItem,
  NodeSystemStatus,
} from '~/types/nodes'
import { toast } from 'vue-sonner'

const { t } = useI18n()
const { ready, hasFeature } = useControlInfo()
const api = useControlApi()
useHead({ title: computed(() => t('manualNodes')) })

const nodes = ref<ManagedNode[]>([])
const status = ref<NodeSystemStatus | null>(null)
const text = ref('')
const tagsText = ref('')
const preview = ref<NodePreviewItem[]>([])
const masked = ref(true)
const busy = ref(false)
const editing = ref<ManagedNode | null>(null)
const editUri = ref('')
const editName = ref('')
const editTags = ref('')
const editMasked = ref(true)
const lines = computed(() =>
  text.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean),
)

async function refresh() {
  status.value = await api.getNodeSystemStatus()
  if (status.value.providerReady && status.value.storageReady)
    nodes.value = await api.listNodes()
  else nodes.value = []
}

watch(
  ready,
  (value) => {
    if (value && hasFeature('nodes'))
      void refresh().catch(() => toast.error(t('manualNodesFailed')))
  },
  { immediate: true },
)

async function run(action: () => Promise<void>, success?: string) {
  if (busy.value) return
  busy.value = true
  try {
    await action()
    if (success) toast.success(success)
  } catch {
    // Never render raw server errors: upstream errors may contain credentials.
    toast.error(t('manualNodesFailed'))
  } finally {
    busy.value = false
  }
}

function parsedTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
}

function showPreview() {
  void run(async () => {
    preview.value = (await api.previewNodes(text.value)).items
  })
}

function importSelected() {
  void run(async () => {
    if (!preview.value.length || preview.value.some((item) => !item.valid))
      return
    const selected = preview.value
      .filter((item) => !item.duplicate)
      .map((item) => lines.value[item.index]!)
      .filter(Boolean)
    if (!selected.length) return
    await api.importNodes(selected, parsedTags(tagsText.value))
    text.value = ''
    tagsText.value = ''
    preview.value = []
    await refresh()
  }, t('manualNodesImported'))
}

async function beginEdit(node: ManagedNode) {
  await run(async () => {
    editUri.value = (await api.getNodeUri(node.id)).uri
    editName.value = node.name
    editTags.value = node.tags.join(', ')
    editMasked.value = true
    editing.value = node
  })
}

function saveEdit() {
  const node = editing.value
  if (!node) return
  void run(async () => {
    await api.updateNode(node.id, {
      uri: editUri.value,
      name: editName.value,
      tags: parsedTags(editTags.value),
      revision: node.updatedAt,
    })
    editing.value = null
    editUri.value = ''
    await refresh()
  }, t('manualNodesSaved'))
}

function cancelEdit() {
  editing.value = null
  editUri.value = ''
}

function deleteNode(node: ManagedNode) {
  if (!window.confirm(t('manualNodesDeleteConfirm', { name: node.name })))
    return
  void run(async () => {
    await api.deleteNode(node.id)
    await refresh()
  }, t('manualNodesDeleted'))
}

function copyNode(node: ManagedNode) {
  void run(async () => {
    const { uri } = await api.getNodeUri(node.id)
    await navigator.clipboard.writeText(uri)
  }, t('manualNodesCopied'))
}

function testNode(node: ManagedNode) {
  void run(async () => {
    await api.testNode(node.id)
    await refresh()
  }, t('manualNodesTested'))
}

function healthcheck() {
  void run(async () => {
    await api.healthcheckManualProvider()
    await refresh()
  }, t('manualNodesHealthcheckStarted'))
}

function reload() {
  void run(async () => {
    await api.reloadManualProvider()
    await refresh()
  }, t('manualNodesReloaded'))
}
</script>

<template>
  <div class="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
    <header class="space-y-2">
      <h1 class="text-2xl font-bold">{{ t('manualNodes') }}</h1>
      <p class="text-sm text-base-content/65">
        {{ t('manualNodesDescription') }}
      </p>
    </header>

    <div v-if="ready && !hasFeature('nodes')" class="alert alert-warning">
      {{ t('manualNodesUnavailable') }}
    </div>
    <template v-else>
      <div
        v-if="
          status &&
          (!status.mihomoReachable ||
            !status.providerReady ||
            !status.storageReady)
        "
        class="alert alert-warning"
      >
        {{ t('manualNodesSetupNeeded') }}
      </div>

      <section
        class="rounded-2xl border border-base-content/10 bg-base-200 p-4 sm:p-5"
      >
        <h2 class="mb-3 text-lg font-semibold">{{ t('manualNodesImport') }}</h2>
        <div class="relative">
          <textarea
            v-model="text"
            rows="6"
            class="textarea-bordered textarea w-full font-mono"
            :class="masked ? 'text-transparent caret-base-content' : ''"
            :aria-label="t('manualNodesUris')"
            :placeholder="masked ? '' : t('manualNodesPasteHint')"
            autocomplete="off"
            spellcheck="false"
            @input="preview = []"
          />
          <div
            v-if="masked"
            class="pointer-events-none absolute inset-1 flex items-start rounded bg-base-100 p-3 text-sm text-base-content/70"
          >
            {{
              lines.length
                ? t('manualNodesMaskedCount', { count: lines.length })
                : t('manualNodesPasteHint')
            }}
          </div>
        </div>
        <div class="mt-2 flex items-center gap-2">
          <label class="cursor-pointer text-sm"
            ><input
              v-model="masked"
              type="checkbox"
              class="checkbox mr-2 checkbox-sm align-middle"
            />{{ t('manualNodesMask') }}</label
          >
        </div>
        <label class="mt-4 block text-sm"
          >{{ t('manualNodesTags') }}
          <input
            v-model="tagsText"
            class="input-bordered input mt-1 w-full"
            placeholder="HK, 自建"
            maxlength="540"
            autocomplete="off"
          />
        </label>
        <div class="mt-4 flex flex-wrap gap-2">
          <button
            class="btn btn-secondary"
            :disabled="busy || !lines.length"
            @click="showPreview"
          >
            {{ t('manualNodesPreview') }}
          </button>
          <button
            class="btn btn-primary"
            :disabled="
              busy ||
              !preview.length ||
              preview.some((item) => !item.valid) ||
              preview.every((item) => item.duplicate)
            "
            @click="importSelected"
          >
            {{ t('manualNodesImport') }}
          </button>
        </div>
        <ul
          v-if="preview.length"
          class="mt-4 space-y-2"
          :aria-label="t('manualNodesPreview')"
        >
          <li
            v-for="item in preview"
            :key="item.index"
            class="rounded-lg bg-base-100 px-3 py-2 text-sm"
          >
            <span class="mr-2 opacity-60">#{{ item.index + 1 }}</span>
            <template v-if="item.valid">
              <strong>{{ item.name }}</strong> · {{ item.protocol }} ·
              {{ item.server }}:{{ item.port }}
              <span v-if="item.duplicate" class="ml-2 badge badge-warning">{{
                t('manualNodesDuplicate')
              }}</span>
            </template>
            <span v-else class="text-error">{{
              item.error === 'UNSUPPORTED_NODE_PROTOCOL'
                ? t('manualNodesUnsupported')
                : t('manualNodesInvalid')
            }}</span>
          </li>
        </ul>
      </section>

      <section
        class="rounded-2xl border border-base-content/10 bg-base-200 p-4 sm:p-5"
      >
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-lg font-semibold">
            {{ t('manualNodesList') }}
            <span class="opacity-60">({{ nodes.length }})</span>
          </h2>
          <div class="flex gap-2">
            <button class="btn btn-sm" :disabled="busy" @click="healthcheck">
              {{ t('manualNodesHealthcheck') }}
            </button>
            <button class="btn btn-sm" :disabled="busy" @click="reload">
              {{ t('manualNodesReload') }}
            </button>
          </div>
        </div>
        <p v-if="!nodes.length" class="text-sm opacity-60">
          {{ t('manualNodesEmpty') }}
        </p>
        <div v-else class="overflow-x-auto">
          <table class="table w-full table-sm">
            <thead>
              <tr>
                <th>{{ t('manualNodesName') }}</th>
                <th>{{ t('manualNodesProtocol') }}</th>
                <th>Server</th>
                <th>Port</th>
                <th>Alive</th>
                <th>Delay</th>
                <th>Tag</th>
                <th>{{ t('manualNodesActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="node in nodes" :key="node.id">
                <td class="font-medium">{{ node.name }}</td>
                <td>{{ node.protocol }}</td>
                <td>{{ node.server }}</td>
                <td>{{ node.port }}</td>
                <td>
                  {{ node.alive === null ? '—' : node.alive ? '✓' : '×' }}
                </td>
                <td>{{ node.delay === null ? '—' : `${node.delay} ms` }}</td>
                <td>
                  <span
                    v-for="tag in node.tags"
                    :key="tag"
                    class="mr-1 badge badge-ghost"
                    >{{ tag }}</span
                  >
                </td>
                <td class="whitespace-nowrap">
                  <button
                    class="btn btn-ghost btn-xs"
                    :disabled="busy"
                    @click="testNode(node)"
                  >
                    {{ t('manualNodesTest') }}
                  </button>
                  <button
                    class="btn btn-ghost btn-xs"
                    :disabled="busy"
                    @click="beginEdit(node)"
                  >
                    {{ t('manualNodesEdit') }}
                  </button>
                  <button
                    class="btn btn-ghost btn-xs"
                    :disabled="busy"
                    @click="copyNode(node)"
                  >
                    {{ t('manualNodesCopy') }}
                  </button>
                  <button
                    class="btn btn-ghost text-error btn-xs"
                    :disabled="busy"
                    @click="deleteNode(node)"
                  >
                    {{ t('manualNodesDelete') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section
        v-if="editing"
        class="rounded-2xl border border-primary/30 bg-base-200 p-4 sm:p-5"
      >
        <h2 class="mb-4 text-lg font-semibold">{{ t('manualNodesEdit') }}</h2>
        <label class="block text-sm"
          >{{ t('manualNodesName')
          }}<input
            v-model="editName"
            class="input-bordered input mt-1 w-full"
            maxlength="128"
        /></label>
        <label class="mt-3 block text-sm"
          >URI<input
            v-model="editUri"
            :type="editMasked ? 'password' : 'text'"
            class="input-bordered input mt-1 w-full font-mono"
            autocomplete="off"
            spellcheck="false"
        /></label>
        <label class="mt-2 flex items-center gap-2 text-sm"
          ><input
            v-model="editMasked"
            type="checkbox"
            class="checkbox checkbox-sm"
          />{{ t('manualNodesMask') }}</label
        >
        <label class="mt-3 block text-sm"
          >{{ t('manualNodesTags')
          }}<input v-model="editTags" class="input-bordered input mt-1 w-full"
        /></label>
        <div class="mt-4 flex gap-2">
          <button class="btn btn-primary" :disabled="busy" @click="saveEdit">
            {{ t('manualNodesSave') }}</button
          ><button class="btn" @click="cancelEdit">
            {{ t('manualNodesCancel') }}
          </button>
        </div>
      </section>
    </template>
  </div>
</template>
