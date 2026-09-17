export type CatalogExercise = {
  id: string;
  name: string;
  muscleGroup: string;
  target: string;
  equipment: string;
  secondary: string[];
};

export const EXERCISE_CATALOG: CatalogExercise[] = [
  { id: 'bench-press', name: 'Bench Press', muscleGroup: 'Chest', target: 'Chest', equipment: 'Barbell', secondary: ['Front Delts', 'Triceps'] },
  { id: 'incline-press', name: 'Incline Press', muscleGroup: 'Chest', target: 'Upper Chest', equipment: 'Barbell', secondary: ['Front Delts', 'Triceps'] },
  { id: 'incline-dumbbell-press', name: 'Incline Dumbbell Press', muscleGroup: 'Chest', target: 'Upper Chest', equipment: 'Dumbbells', secondary: ['Front Delts', 'Triceps'] },
  { id: 'cable-fly', name: 'Cable Fly', muscleGroup: 'Chest', target: 'Chest', equipment: 'Cable', secondary: ['Front Delts'] },
  { id: 'dumbbell-fly', name: 'Dumbbell Fly', muscleGroup: 'Chest', target: 'Chest', equipment: 'Dumbbells', secondary: ['Front Delts'] },
  { id: 'push-ups', name: 'Push-Ups', muscleGroup: 'Chest', target: 'Chest', equipment: 'Bodyweight', secondary: ['Front Delts', 'Triceps'] },
  { id: 'chest-dip', name: 'Chest Dip', muscleGroup: 'Chest', target: 'Lower Chest', equipment: 'Bodyweight', secondary: ['Triceps'] },
  { id: 'deadlift', name: 'Deadlift', muscleGroup: 'Back', target: 'Posterior Chain', equipment: 'Barbell', secondary: ['Glutes', 'Hamstrings'] },
  { id: 'pullups', name: 'Pull-Ups', muscleGroup: 'Back', target: 'Lats', equipment: 'Bodyweight', secondary: ['Biceps'] },
  { id: 'lat-pulldown', name: 'Lat Pulldown', muscleGroup: 'Back', target: 'Lats', equipment: 'Machine', secondary: ['Biceps'] },
  { id: 'barbell-row', name: 'Barbell Row', muscleGroup: 'Back', target: 'Lats', equipment: 'Barbell', secondary: ['Biceps'] },
  { id: 'seated-cable-row', name: 'Seated Cable Row', muscleGroup: 'Back', target: 'Mid Back', equipment: 'Cable', secondary: ['Biceps'] },
  { id: 'face-pulls', name: 'Face Pulls', muscleGroup: 'Shoulders', target: 'Rear Delts', equipment: 'Cable', secondary: ['Upper Back'] },
  { id: 'overhead-press', name: 'Overhead Press', muscleGroup: 'Shoulders', target: 'Front Delts', equipment: 'Barbell', secondary: ['Triceps'] },
  { id: 'lateral-raises', name: 'Dumbbell Lateral Raise', muscleGroup: 'Shoulders', target: 'Side Delts', equipment: 'Dumbbells', secondary: [] },
  { id: 'rear-delt-fly', name: 'Rear Delt Fly', muscleGroup: 'Shoulders', target: 'Rear Delts', equipment: 'Dumbbells', secondary: [] },
  { id: 'arnold-press', name: 'Arnold Press', muscleGroup: 'Shoulders', target: 'Front Delts', equipment: 'Dumbbells', secondary: ['Triceps'] },
  { id: 'bicep-curls', name: 'Dumbbell Bicep Curl', muscleGroup: 'Arms', target: 'Biceps', equipment: 'Dumbbells', secondary: [] },
  { id: 'hammer-curls', name: 'Hammer Curl', muscleGroup: 'Arms', target: 'Biceps', equipment: 'Dumbbells', secondary: ['Forearms'] },
  { id: 'tricep-pushdown', name: 'Cable Tricep Pushdown', muscleGroup: 'Arms', target: 'Triceps', equipment: 'Cable', secondary: [] },
  { id: 'skull-crushers', name: 'Skull Crushers', muscleGroup: 'Arms', target: 'Triceps', equipment: 'Barbell', secondary: [] },
  { id: 'overhead-tricep-ext', name: 'Overhead Tricep Extension', muscleGroup: 'Arms', target: 'Triceps', equipment: 'Dumbbells', secondary: [] },
  { id: 'wrist-curls', name: 'Dumbbell Wrist Curl', muscleGroup: 'Arms', target: 'Forearms', equipment: 'Dumbbells', secondary: [] },
  { id: 'squats', name: 'Barbell Squat', muscleGroup: 'Legs', target: 'Quads', equipment: 'Barbell', secondary: ['Glutes'] },
  { id: 'leg-press', name: 'Leg Press', muscleGroup: 'Legs', target: 'Quads', equipment: 'Machine', secondary: ['Glutes'] },
  { id: 'romanian-deadlift', name: 'Romanian Deadlift', muscleGroup: 'Legs', target: 'Hamstrings', equipment: 'Barbell', secondary: ['Glutes'] },
  { id: 'leg-curl', name: 'Lying Leg Curl', muscleGroup: 'Legs', target: 'Hamstrings', equipment: 'Machine', secondary: [] },
  { id: 'leg-extension', name: 'Leg Extension', muscleGroup: 'Legs', target: 'Quads', equipment: 'Machine', secondary: [] },
  { id: 'walking-lunges', name: 'Walking Lunges', muscleGroup: 'Legs', target: 'Quads', equipment: 'Dumbbells', secondary: ['Glutes'] },
  { id: 'calf-raises', name: 'Standing Calf Raise', muscleGroup: 'Legs', target: 'Calves', equipment: 'Machine', secondary: [] },
  { id: 'hip-thrust', name: 'Barbell Hip Thrust', muscleGroup: 'Glutes', target: 'Glutes', equipment: 'Barbell', secondary: ['Hamstrings'] },
  { id: 'hanging-leg-raise', name: 'Hanging Leg Raise', muscleGroup: 'Core', target: 'Abs', equipment: 'Bodyweight', secondary: [] },
  { id: 'cable-crunch', name: 'Cable Crunch', muscleGroup: 'Core', target: 'Abs', equipment: 'Cable', secondary: [] },
  { id: 'plank', name: 'Plank', muscleGroup: 'Core', target: 'Abs', equipment: 'Bodyweight', secondary: [] },
  { id: 'russian-twist', name: 'Russian Twist', muscleGroup: 'Core', target: 'Obliques', equipment: 'Bodyweight', secondary: [] },
];

export const WEEKDAY_LABELS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
