export type Sex = "female" | "male";
export type Activity = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type Goal = "lose" | "maintain" | "gain";
export type MacroStyle = "balanced" | "high_protein" | "low_carb";

export interface ProfileInput {
  macro_style?: MacroStyle;
  sex: Sex;
  birth_year: number;
  height_cm: number;
  weight_kg: number;
  goal_weight_kg: number;
  activity: Activity;
  goal: Goal;
  weekly_rate_kg: number;
}

export interface Targets {
  bmr: number;
  tdee: number;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  bmi: number;
  warnings: string[];
}

const ACTIVITY_FACTOR: Record<Activity, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

// ~7700 kcal per kg of body weight
const KCAL_PER_KG = 7700;
const MIN_CALORIES: Record<Sex, number> = { female: 1200, male: 1500 };

const MACRO_STYLE: Record<MacroStyle, { proteinPerKg: number; fatShare: number }> = {
  balanced: { proteinPerKg: 1.6, fatShare: 0.27 },
  high_protein: { proteinPerKg: 2.0, fatShare: 0.25 },
  low_carb: { proteinPerKg: 1.8, fatShare: 0.4 },
};

/** Mifflin–St Jeor BMR → TDEE → goal-adjusted target with safety floors. */
export function computeTargets(p: ProfileInput, now = new Date()): Targets {
  const age = now.getFullYear() - p.birth_year;
  const bmr = 10 * p.weight_kg + 6.25 * p.height_cm - 5 * age + (p.sex === "male" ? 5 : -161);
  const tdee = bmr * ACTIVITY_FACTOR[p.activity];
  const heightM = p.height_cm / 100;
  const bmi = p.weight_kg / (heightM * heightM);
  const goalBmi = p.goal_weight_kg / (heightM * heightM);
  const warnings: string[] = [];

  const dailyDelta = (p.weekly_rate_kg * KCAL_PER_KG) / 7;
  let calories = tdee;
  if (p.goal === "lose") calories = tdee - dailyDelta;
  if (p.goal === "gain") calories = tdee + dailyDelta;

  if (p.goal === "lose" && bmi < 18.5) {
    calories = tdee;
    warnings.push("Your BMI is already below 18.5, so FittonesuGo set your target to maintenance. Please talk to a doctor or dietitian before trying to lose weight.");
  } else if (p.goal === "lose" && goalBmi < 18.5) {
    warnings.push("Your goal weight is below a healthy BMI of 18.5. Consider a higher goal weight.");
  }

  if (calories < MIN_CALORIES[p.sex]) {
    calories = MIN_CALORIES[p.sex];
    warnings.push(`Your target was raised to the ${MIN_CALORIES[p.sex]} kcal minimum. Try a slower weekly rate or add activity instead.`);
  }

  // Macros: protein g/kg (capped at goal-relevant weight) and fat share depend on the macro style; carbs fill the rest
  const style = MACRO_STYLE[p.macro_style ?? "balanced"];
  const proteinBase = Math.min(p.weight_kg, Math.max(p.goal_weight_kg, p.weight_kg * 0.85));
  const protein_g = Math.round(proteinBase * style.proteinPerKg);
  const fat_g = Math.round((calories * style.fatShare) / 9);
  const carbs_g = Math.max(0, Math.round((calories - protein_g * 4 - fat_g * 9) / 4));

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    calories: Math.round(calories),
    protein_g,
    carbs_g,
    fat_g,
    bmi: Math.round(bmi * 10) / 10,
    warnings,
  };
}
