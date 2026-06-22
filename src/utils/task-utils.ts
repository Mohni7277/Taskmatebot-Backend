// src/utils/task-utils.ts
import { format, isToday, isTomorrow, isPast, isValid, parseISO, addDays } from "date-fns";

// Define a type for grouped tasks
export interface TaskGroup {
  dateLabel: string;
  formattedDate: string;
  tasks: any[];
  sortOrder: number; // Used for sorting groups
}

/**
 * Groups tasks by their deadline date
 * @param tasks Array of tasks to group
 * @returns Array of task groups sorted by date
 */
export function groupTasksByDate(tasks: any[]): TaskGroup[] {
  // Create a map to hold our groups
  const groups: Map<string, TaskGroup> = new Map();

  // Special group for tasks with no deadline
  const noDeadlineGroup: TaskGroup = {
    dateLabel: "No Deadline",
    formattedDate: "No Deadline",
    tasks: [],
    sortOrder: Number.MAX_SAFE_INTEGER // This will place it at the end
  };

  // Special group for overdue tasks
  const overdueGroup: TaskGroup = {
    dateLabel: "Overdue",
    formattedDate: "Overdue",
    tasks: [],
    sortOrder: 0 // This will place it at the beginning
  };

  // Process each task
  tasks.forEach(task => {
    if (!task.deadline) {
      // Add to the no deadline group
      noDeadlineGroup.tasks.push(task);
      return;
    }

    const deadlineDate = parseISO(task.deadline);

    // Skip invalid dates
    if (!isValid(deadlineDate)) {
      noDeadlineGroup.tasks.push(task);
      return;
    }

    // Check if the task is overdue (past deadline and not completed)
    if (isPast(deadlineDate) && task.status !== "completed" && !isToday(deadlineDate)) {
      overdueGroup.tasks.push(task);
      return;
    }

    // Format the date for grouping
    const dateKey = format(deadlineDate, "yyyy-MM-dd");

    // Create a user-friendly label
    let dateLabel;
    let sortOrder;

    if (isToday(deadlineDate)) {
      dateLabel = "Today";
      sortOrder = 1; // Right after Overdue
    } else if (isTomorrow(deadlineDate)) {
      dateLabel = "Tomorrow";
      sortOrder = 2; // Right after Today
    } else {
      // For other dates, use a formatted date
      dateLabel = format(deadlineDate, "EEEE, MMMM d, yyyy");

      // Calculate days from today for sorting
      const today = new Date();
      const diffTime = deadlineDate.getTime() - today.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      sortOrder = diffDays + 2; // +2 to place after "Tomorrow" (which has sortOrder 2)
    }

    // Get or create the group
    if (!groups.has(dateKey)) {
      groups.set(dateKey, {
        dateLabel,
        formattedDate: format(deadlineDate, "MMMM d, yyyy"),
        tasks: [],
        sortOrder
      });
    }

    // Add the task to its group
    groups.get(dateKey)?.tasks.push(task);
  });

  // Convert the map to an array and add special groups if they have tasks
  const groupsArray = Array.from(groups.values());

  if (overdueGroup.tasks.length > 0) {
    groupsArray.unshift(overdueGroup);
  }

  if (noDeadlineGroup.tasks.length > 0) {
    groupsArray.push(noDeadlineGroup);
  }

  // Sort the groups by their sortOrder
  return groupsArray.sort((a, b) => a.sortOrder - b.sortOrder);
}
