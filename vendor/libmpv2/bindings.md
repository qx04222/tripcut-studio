# List of libmpv functions supported

- [ ] `mpv_client_api_version`
- [X] `mpv_error_string`
- [X] `mpv_free` (not public, internal use only)
- [ ] `mpv_client_name`
- [ ] `mpv_client_id`

- [X] `mpv_create`
- [X] `mpv_initialize`
- [ ] `mpv_destroy`
- [X] `mpv_terminate_destroy` (not public, internal use only)
- [X] `mpv_create_client`
- [ ] `mpv_create_weak_client`

- [X] `mpv_load_config_file`

- [X] `mpv_get_time_ns`
- [X] `mpv_get_time_us`

- [ ] `mpv_free_node_contents`

- [X] `mpv_set_option`
- [ ] `mpv_set_option_string`

- [X] `mpv_command`
- [ ] `mpv_command_node`
- [ ] `mpv_command_ret`
- [ ] `mpv_command_string`
- [ ] `mpv_command_async`
- [ ] `mpv_command_node_async`
- [ ] `mpv_abort_async_command`

- [X] `mpv_set_property`
- [ ] `mpv_set_property_string`
- [ ] `mpv_del_property`
- [ ] `mpv_set_property_async`
- [X] `mpv_get_property`
- [ ] `mpv_get_property_string`
- [ ] `mpv_get_property_osd_string`
- [ ] `mpv_get_property_async`
- [X] `mpv_observe_property`
- [X] `mpv_unobserve_property`

- [ ] `mpv_event_name`
- [ ] `mpv_event_to_node`
- [X] `mpv_request_event`
- [ ] `mpv_request_log_messages`
- [X] `mpv_wait_event`
- [ ] `mpv_wakeup`
- [X] `mpv_set_wakeup_callback`
- [ ] `mpv_wait_async_requests`

- [ ] `mpv_hook_add`
- [ ] `mpv_hook_continue`

- [X] `mpv_render_context_create`
- [X] `mpv_render_context_set_parameter`
- [X] `mpv_render_context_get_info`
- [X] `mpv_render_context_set_update_callback`
- [X] `mpv_render_context_update`
- [X] `mpv_render_context_render`
- [X] `mpv_render_context_report_swap`
- [X] `mpv_render_context_free` (not public, internal use only)

- [X] `mpv_stream_cb_add_ro`
