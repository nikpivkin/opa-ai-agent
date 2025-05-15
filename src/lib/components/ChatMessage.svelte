<script lang="ts">
  let {
    content,
    side,
  }: {
    content: string;
    side: "left" | "right";
  } = $props();
</script>

<div
  class={`flex flex-col w-full leading-1.5 p-2
    ${side === "right" ? "items-end" : "items-start"}`}
>
  <div
    class={`max-w-[75%] px-4 py-2
      ${
        side === "right"
          ? "bg-blue-500 text-white rounded-l-xl rounded-br-xl"
          : "bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white rounded-r-xl rounded-bl-xl"
      }`}
  >
    <p class="text-sm font-normal">
      {content}
    </p>
  </div>
</div>
