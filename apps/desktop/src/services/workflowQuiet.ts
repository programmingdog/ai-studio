import { useQuery, type QueryClient } from "@tanstack/react-query";
const key = ["automatic-workflow-quiet"];
export const runningWorkflows = new Set<string>();
export function setWorkflowQuiet(client: QueryClient, id: string, running: boolean) {
  client.setQueryData<string[]>(key, previous => running ? [...new Set([...(previous??[]),id])] : (previous??[]).filter(value=>value!==id));
}
export function useWorkflowQuiet() {
  return useQuery({queryKey:key,queryFn:()=>[] as string[],enabled:false,initialData:[] as string[]}).data.length>0;
}
