package utils

import (
	"fmt"
	"reflect"
)

// This file replaces github.com/fatih/structs, which has had no release since
// 2018. Everything below is the small slice of that package this project
// actually used: walk an Options struct's fields, read its `flagName` /
// `flagSName` / `flagDescribe` / `default` tags, and set a field by value.
//
// The API shape is kept deliberately close to the one it replaces (Name, Tag,
// Kind, Value, Set) so the flag-generation call sites did not have to be
// restructured at the same time they changed libraries. Flag generation is
// reflection over tags: a subtle difference here would silently change a
// default rather than fail to compile, so the change worth reviewing is this
// file, not the call sites.

// structField is one settable field of an Options struct.
type structField struct {
	name  string
	tag   reflect.StructTag
	value reflect.Value
}

func (f structField) Name() string          { return f.name }
func (f structField) Tag(key string) string { return f.tag.Get(key) }
func (f structField) Kind() reflect.Kind    { return f.value.Kind() }
func (f structField) Value() interface{}    { return f.value.Interface() }
func (f structField) Set(val interface{})   { f.value.Set(reflect.ValueOf(val)) }

// structFields returns the exported fields of a struct pointer.
//
// A pointer is required, not merely accepted: every caller here mutates the
// fields it is given, and reflect cannot write through a non-pointer copy. The
// old library reported that as an error from Set, on each field, long after the
// mistake; failing once at the top is the same check made earlier and louder.
//
// Unexported fields are skipped because reflect can neither read nor write
// them, and none of the Options structs has one.
func structFields(v interface{}) ([]structField, error) {
	value := reflect.ValueOf(v)
	if value.Kind() != reflect.Ptr || value.IsNil() {
		return nil, fmt.Errorf("expected a non-nil pointer to a struct, got %T", v)
	}
	value = value.Elem()
	if value.Kind() != reflect.Struct {
		return nil, fmt.Errorf("expected a pointer to a struct, got a pointer to %s", value.Kind())
	}

	t := value.Type()
	fields := make([]structField, 0, t.NumField())
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.PkgPath != "" { // unexported
			continue
		}
		fields = append(fields, structField{
			name:  f.Name,
			tag:   f.Tag,
			value: value.Field(i),
		})
	}
	return fields, nil
}

// fieldsByName indexes several option structs by Go field name, so a flag can
// be routed to whichever struct declares it. Earlier structs win a name
// collision, matching the order the caller passed them in.
func fieldsByName(options ...interface{}) (map[string]structField, error) {
	index := make(map[string]structField)
	for _, o := range options {
		fields, err := structFields(o)
		if err != nil {
			return nil, err
		}
		for _, f := range fields {
			if _, seen := index[f.Name()]; !seen {
				index[f.Name()] = f
			}
		}
	}
	return index, nil
}
