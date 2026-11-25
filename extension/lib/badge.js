// The toolbar badge. Until site access is granted the worker can't read tab
// URLs, so one grey "!" ("action needed") shows in every tab.
export const GREY = "#80868b";

export function badge({ granted }) {
  return { text: granted ? "" : "!", color: GREY };
}
