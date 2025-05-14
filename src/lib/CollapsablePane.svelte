<script lang="ts">
  import { AngleRightOutline, AngleDownOutline } from "flowbite-svelte-icons";
  import { Pane, type PaneProps } from "paneforge";
  import type { Snippet } from "svelte";

  type Props = {
    header: string;
    children: Snippet;
  } & Omit<PaneProps, "collapsible" | "onCollapse" | "onExpand">;

  let { header, children, ...restProps }: Props = $props();

  let pane = $state<Pane>(null!);
  let collapsed = $state(false);
</script>

<div class="flex justify-items-center p-1">
  {#if collapsed}
    <button
      onclick={() => {
        pane?.expand();
      }}
    >
      <AngleRightOutline />
    </button>
  {:else}
    <button
      onclick={() => {
        pane?.collapse();
      }}
    >
      <AngleDownOutline />
    </button>
  {/if}
  <h3 class="text-base font-semibold">{header}</h3>
</div>
<Pane
  collapsedSize={0}
  collapsible={true}
  minSize={10}
  defaultSize={50}
  bind:this={pane}
  onCollapse={() => (collapsed = true)}
  onExpand={() => (collapsed = false)}
  {...restProps}
>
  {@render children()}
</Pane>
