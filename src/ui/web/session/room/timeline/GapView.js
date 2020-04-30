import {TemplateView} from "../../../general/TemplateView.js";

export class GapView extends TemplateView {
    render(t, vm) {
        const className = {
            GapView: true,
            isLoading: vm => vm.isLoading
        };
        const label = (vm.isUp ? "🠝" : "🠟") + " fill gap"; //no binding
        return t.li({className}, [
            t.button({
                onClick: () => vm.fill(),
                disabled: vm => vm.isLoading
            }, label),
            t.if(vm => vm.error, t.createTemplate(t => t.strong(vm => vm.error)))
        ]);
    }
}
