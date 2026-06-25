import { DayPicker, type DayPickerProps } from 'react-day-picker';
import { cn } from '../../lib/utils.js';
import { buttonVariants } from './button.js';

export type CalendarProps = DayPickerProps;

export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0',
        month: 'space-y-4',
        month_caption: 'flex justify-center pt-1 relative items-center',
        caption_label: 'text-sm font-medium text-text-primary',
        nav: 'space-x-1 flex items-center',
        button_previous: cn(
          buttonVariants({ variant: 'outline' }),
          'h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100 absolute left-1',
        ),
        button_next: cn(
          buttonVariants({ variant: 'outline' }),
          'h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100 absolute right-1',
        ),
        month_grid: 'w-full border-collapse space-y-1',
        weekdays: 'flex',
        weekday:
          'text-text-secondary rounded-md w-9 font-normal text-[0.8rem]',
        week: 'flex w-full mt-2',
        day: 'h-9 w-9 text-center text-sm p-0 relative focus-within:relative focus-within:z-20',
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'h-9 w-9 p-0 font-normal aria-selected:opacity-100',
        ),
        selected:
          'bg-accent text-white rounded-md hover:bg-accent-hover hover:text-white focus:bg-accent-hover focus:text-white',
        range_start:
          'aria-selected:rounded-l-md aria-selected:rounded-r-none',
        range_end:
          'aria-selected:rounded-r-md aria-selected:rounded-l-none',
        range_middle:
          'aria-selected:bg-bg-tertiary aria-selected:text-text-primary aria-selected:rounded-none',
        today: 'bg-bg-tertiary text-text-primary rounded-md',
        outside:
          'outside text-text-secondary opacity-50 aria-selected:bg-bg-tertiary/50 aria-selected:text-text-secondary aria-selected:opacity-30',
        disabled: 'text-text-secondary opacity-50',
        hidden: 'invisible',
        ...classNames,
      }}
      {...props}
    />
  );
}

Calendar.displayName = 'Calendar';
