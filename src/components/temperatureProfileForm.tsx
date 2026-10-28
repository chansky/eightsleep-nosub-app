"use client";
import React, { useState, useEffect } from "react";
import { useForm, Controller, type Control } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiR } from "~/trpc/react";
import TimezoneSelect, { allTimezones } from "react-timezone-select";
import { Button } from "./ui/button";
import { getTemperatureSchedule } from "~/lib/temperature-schedule";

const temperatureProfileSchema = z.object({
  bedTime: z.string().regex(/^\d{2}:\d{2}$/, "Must be in HH:MM format"),
  wakeupTime: z.string().regex(/^\d{2}:\d{2}$/, "Must be in HH:MM format"),
  initialSleepLevel: z.number().min(-10).max(10),
  midStageSleepLevel: z.number().min(-10).max(10),
  finalSleepLevel: z.number().min(-10).max(10),
  automaticFinalStage: z.boolean(),
  finalStageStartTime: z.string().regex(/^\d{2}:\d{2}$/, "Must be in HH:MM format"),
  timezone: z.object({
    value: z.string(),
    altName: z.string().optional(),
    abbrev: z.string().optional(),
  }),
}).superRefine((profile, ctx) => {
  try {
    getTemperatureSchedule({
      ...profile,
      finalStageStartTime: profile.automaticFinalStage ? null : profile.finalStageStartTime,
    });
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["finalStageStartTime"],
      message: error instanceof Error ? error.message : "Invalid temperature schedule.",
    });
  }
});

type TemperatureProfileForm = z.infer<typeof temperatureProfileSchema>;

export const TemperatureProfileForm: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [isExistingProfile, setIsExistingProfile] = useState(false);
  const [sleepDurationError, setSleepDurationError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const utils = apiR.useUtils();

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<TemperatureProfileForm>({
    resolver: zodResolver(temperatureProfileSchema),
    defaultValues: {
      bedTime: "22:00",
      wakeupTime: "06:00",
      initialSleepLevel: 0,
      midStageSleepLevel: 0,
      finalSleepLevel: 0,
      automaticFinalStage: true,
      finalStageStartTime: "04:00",
      timezone: { value: "America/New_York"},
    },
  });

  const bedTime = watch("bedTime");
  const wakeupTime = watch("wakeupTime");
  const automaticFinalStage = watch("automaticFinalStage");
  const finalStageStartTime = watch("finalStageStartTime");
  const timezone = watch("timezone");

  const [sleepInfo, setSleepInfo] = useState({
    duration: "",
    midStageTime: "",
    finalStageTime: "",
  });

  const getUserTemperatureProfileQuery = apiR.user.getUserTemperatureProfile.useQuery();
  

  useEffect(() => {
    if (getUserTemperatureProfileQuery.isSuccess) {
      const profile = getUserTemperatureProfileQuery.data;
      setValue("bedTime", profile.bedTime.slice(0, 5));
      setValue("wakeupTime", profile.wakeupTime.slice(0, 5));
      setValue("initialSleepLevel", profile.initialSleepLevel / 10);
      setValue("midStageSleepLevel", profile.midStageSleepLevel / 10);
      setValue("finalSleepLevel", profile.finalSleepLevel / 10);
      setValue("automaticFinalStage", profile.finalStageStartTime == null);
      setValue("finalStageStartTime", profile.finalStageStartTime?.slice(0, 5) ?? "04:00");
      setValue("timezone", { value: profile.timezoneTZ });
      setIsExistingProfile(true);
      setIsLoading(false);
    } else if (getUserTemperatureProfileQuery.isError) {
      if (getUserTemperatureProfileQuery.error.data?.code === "NOT_FOUND") {
        setIsExistingProfile(false);
      }
      setIsLoading(false);
    }
  }, [getUserTemperatureProfileQuery.isSuccess, getUserTemperatureProfileQuery.isError, getUserTemperatureProfileQuery.data, setValue, getUserTemperatureProfileQuery.error]);

  useEffect(() => {
    try {
      const schedule = getTemperatureSchedule({
        bedTime,
        wakeupTime,
        finalStageStartTime: automaticFinalStage ? null : finalStageStartTime,
      });
      const hours = Math.floor(schedule.durationMinutes / 60);
      const minutes = Math.floor(schedule.durationMinutes % 60);
      setSleepDurationError(null);
      setSleepInfo({
        duration: `${hours} hours ${minutes} minutes`,
        midStageTime: schedule.midStageTime,
        finalStageTime: schedule.finalStageTime,
      });
    } catch (error) {
      setSleepDurationError(error instanceof Error ? error.message : "Invalid temperature schedule.");
      setSleepInfo({ duration: "", midStageTime: "", finalStageTime: "" });
    }
  }, [bedTime, wakeupTime, automaticFinalStage, finalStageStartTime]);

  const updateProfileMutation =
    apiR.user.updateUserTemperatureProfile.useMutation({
      onSuccess: async (result) => {
        setSaveMessage(`Profile saved for ${result.email}.`);
        setIsExistingProfile(true); // Update the state after successful creation/update
        await Promise.all([
          utils.user.getUserTemperatureProfile.invalidate(),
          utils.user.getTemperatureDiagnostics.invalidate(),
        ]);
      },
    });

  const deleteProfileMutation =
    apiR.user.deleteUserTemperatureProfile.useMutation({
      onSuccess: () => {
        setSaveMessage(null);
        setIsExistingProfile(false);
        reset(); // Reset form to default values
      },
    });

  const onSubmit = (data: TemperatureProfileForm) => {
    setSaveMessage(null);
    if (sleepDurationError) {
      return; // Prevent submission if there's a sleep duration error
    }

    const formatTimeForAPI = (time: string) => `${time}:00.000000`;

    const mutationData = {
      bedTime: formatTimeForAPI(data.bedTime),
      wakeupTime: formatTimeForAPI(data.wakeupTime),
      initialSleepLevel: Math.round(data.initialSleepLevel * 10),
      midStageSleepLevel: Math.round(data.midStageSleepLevel * 10),
      finalSleepLevel: Math.round(data.finalSleepLevel * 10),
      finalStageStartTime: data.automaticFinalStage ? null : formatTimeForAPI(data.finalStageStartTime),
      timezoneTZ: data.timezone.value,
    };

    updateProfileMutation.mutate(mutationData);
  };

  const onDelete = () => {
    if (window.confirm("Are you sure you want to delete your temperature profile?")) {
      deleteProfileMutation.mutate();
    }
  };

  const SliderInput: React.FC<{
    name: "initialSleepLevel" | "midStageSleepLevel" | "finalSleepLevel";
    label: string;
    control: Control<TemperatureProfileForm>;
    info?: string;
  }> = ({ name, label, control, info }) => (
    <div className="mb-4">
      <label htmlFor={name} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      <Controller
        name={name}
        control={control}
        render={({ field: { onChange, value } }) => (
          <div className="flex items-center">
            <input
              type="range"
              min="-10"
              max="10"
              step="1"
              value={value}
              onChange={(e) => onChange(Number(e.target.value))}
              className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200"
            />
            <span className="ml-2 text-sm text-gray-600">{value}</span>
          </div>
        )}
      />
      {info && <p className="mt-1 text-sm text-blue-600">{info}</p>}
      {errors[name] && (
        <p className="mt-1 text-sm text-red-600">{errors[name]?.message}</p>
      )}
    </div>
  );

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (getUserTemperatureProfileQuery.isError && getUserTemperatureProfileQuery.error.data?.code !== "NOT_FOUND") {
    return (
      <div role="alert" className="mx-auto mt-8 w-full max-w-md rounded-lg bg-white p-6 text-gray-800 shadow-xl">
        <h2 className="text-lg font-semibold">Your profile could not be loaded</h2>
        <p className="mt-2 text-sm">{getUserTemperatureProfileQuery.error.message}</p>
        <p className="mt-2 text-sm text-gray-600">Load your saved settings before making changes.</p>
        <Button type="button" variant="outline" className="mt-4" onClick={() => void getUserTemperatureProfileQuery.refetch()} disabled={getUserTemperatureProfileQuery.isFetching}>
          {getUserTemperatureProfileQuery.isFetching ? "Loading…" : "Retry loading profile"}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-8 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
      <h2 className="mb-4 text-center text-2xl font-bold text-gray-800">
        {isExistingProfile ? "Update" : "Create"} Temperature Profile
      </h2>
      {getUserTemperatureProfileQuery.data && (
        <p className="mb-4 break-words rounded-md bg-indigo-50 p-3 text-sm text-indigo-900">
          Editing schedule for <strong>{getUserTemperatureProfileQuery.data.email}</strong>
        </p>
      )}
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="space-y-4 text-gray-800"
      >
        <div>
          <label
            htmlFor="timezone"
            className="block text-sm font-medium text-gray-700"
          >
            Timezone
          </label>
          <Controller
            name="timezone"
            control={control}
            render={({ field }) => (
              <TimezoneSelect
                value={field.value.value}
                onChange={field.onChange}
                timezones={{
                  ...allTimezones,
                  "America/New_York": "America/New York",
                  "America/Los_Angeles": "America/Los Angeles",
                }}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
              />
            )}
          />
          {errors.timezone && (
            <p className="mt-1 text-sm text-red-600">
              {errors.timezone.message}
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor="bedTime"
            className="block text-sm font-medium text-gray-700"
          >
            Bed Time
          </label>
          <input
            {...register("bedTime")}
            type="time"
            id="bedTime"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
          />
          {errors.bedTime && (
            <p className="mt-1 text-sm text-red-600">
              {errors.bedTime.message}
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor="wakeupTime"
            className="block text-sm font-medium text-gray-700"
          >
            Wake-up Time
          </label>
          <input
            {...register("wakeupTime")}
            type="time"
            id="wakeupTime"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
          />
          {errors.wakeupTime && (
            <p className="mt-1 text-sm text-red-600">
              {errors.wakeupTime.message}
            </p>
          )}
        </div>

        <div className="rounded-md bg-blue-50 p-4">
          {sleepDurationError ? (
            <p className="text-sm text-red-600">{sleepDurationError}</p>
          ) : (
            <p className="text-sm text-blue-800">
              Sleep Duration: {sleepInfo.duration}
              <br />
              Bed will prepare for sleep one hour before the bed time.
            </p>
          )}
        </div>

        <SliderInput
          name="initialSleepLevel"
          label="Initial Sleep Level"
          control={control}
          info={`Starts at ${bedTime}`}
        />
        <SliderInput
          name="midStageSleepLevel"
          label="Mid-Stage Sleep Level"
          control={control}
          info={`Starts at ${sleepInfo.midStageTime}`}
        />
        <div className="space-y-3 rounded-md border border-indigo-100 bg-indigo-50 p-4">
          <label htmlFor="finalStageStartTime" className="block text-sm font-semibold text-gray-800">
            Final stage starts at
          </label>
          <Controller
            name="finalStageStartTime"
            control={control}
            render={({ field }) => (
              <input
                {...field}
                type="time"
                id="finalStageStartTime"
                value={automaticFinalStage ? sleepInfo.finalStageTime : field.value}
                disabled={automaticFinalStage}
                className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 disabled:bg-gray-100 disabled:text-gray-600"
                aria-describedby="final-stage-time-help"
              />
            )}
          />
          <Controller
            name="automaticFinalStage"
            control={control}
            render={({ field }) => (
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={field.value}
                  onBlur={field.onBlur}
                  ref={field.ref}
                  name={field.name}
                  onChange={(event) => {
                    if (!event.target.checked && sleepInfo.finalStageTime) {
                      setValue("finalStageStartTime", sleepInfo.finalStageTime);
                    }
                    field.onChange(event.target.checked);
                    setSaveMessage(null);
                  }}
                  className="mt-1"
                />
                Use automatic start: two hours before wake-up
              </label>
            )}
          />
          <p id="final-stage-time-help" className="text-xs leading-relaxed text-indigo-900">
            {automaticFinalStage
              ? "Uncheck automatic start to choose a final-stage time independently of wake-up."
              : "This time stays fixed when you change wake-up. Use automatic start to return to two hours before wake-up."}
            {" "}All schedule times use {timezone.value}.
          </p>
          {errors.finalStageStartTime && <p className="text-sm text-red-600">{errors.finalStageStartTime.message}</p>}
        </div>
        <SliderInput
          name="finalSleepLevel"
          label="Final Sleep Level"
          control={control}
          info={sleepInfo.finalStageTime ? `Starts at ${sleepInfo.finalStageTime} and continues until wake-up at ${wakeupTime}` : undefined}
        />

        <div className="flex justify-between">
          <Button
            type="submit"
            className="flex-grow rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            disabled={updateProfileMutation.isPending || !!sleepDurationError}
          >
            {updateProfileMutation.isPending ? "Updating..." : (isExistingProfile ? "Update" : "Create") + " Profile"}
          </Button>
          {isExistingProfile && (
            <Button
              type="button"
              onClick={onDelete}
              className="ml-4 rounded-md border border-transparent bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              disabled={deleteProfileMutation.isPending}
            >
              {deleteProfileMutation.isPending ? "Deleting..." : "Delete Schedule"}
            </Button>
          )}
        </div>
        {saveMessage && (
          <p role="status" className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
            {saveMessage}
          </p>
        )}
        {updateProfileMutation.isError && (
          <p className="mt-4 text-center text-sm text-red-600">
            Error updating profile. Please try again.
            {updateProfileMutation.error.message}
          </p>
        )}
        {deleteProfileMutation.isError && (
          <p className="mt-4 text-center text-sm text-red-600">
            Error deleting profile. Please try again.
            {deleteProfileMutation.error.message}
          </p>
        )}
      </form>
    </div>
  );
};
